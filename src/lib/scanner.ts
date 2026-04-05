import { ethers } from "ethers";
import {
  createDelegatedEvmWalletClient,
  delegatedSignTransaction,
  delegatedSignTypedData,
} from "@dynamic-labs-wallet/node-evm";
import type {
  DelegatedEvmWalletClient,
  ServerKeyShare,
} from "@dynamic-labs-wallet/node-evm";
import type { Order, Proposal } from "./db/schema";
import { OrderType } from "./types";

const UNISWAP_API = "https://trade-api.gateway.uniswap.org/v1";
const BASE_CHAIN_ID = 8453;

// Sentinel address used by some protocols to represent native ETH
const NATIVE_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// Buffer multiplier for gas estimates (120% of simulated gas)
const GAS_BUFFER_NUMERATOR = 12n;
const GAS_BUFFER_DENOMINATOR = 10n;

const ERC20_INTERFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export interface TraderCredentials {
  walletId: string;
  walletApiKey: string;
  /** Parsed ServerKeyShare — JSON.parse(user.delegated_share) before passing */
  keyShare: ServerKeyShare;
  walletAddress: string;
}

export class Trader {
  private delegatedClient: DelegatedEvmWalletClient;
  private provider: ethers.JsonRpcProvider;
  private credentials: {
    walletId: string;
    walletApiKey: string;
    keyShare: ServerKeyShare;
  };
  private walletAddress: string;

  constructor({
    walletId,
    walletApiKey,
    keyShare,
    walletAddress,
  }: TraderCredentials) {
    this.credentials = { walletId, walletApiKey, keyShare };
    this.walletAddress = walletAddress;

    this.delegatedClient = createDelegatedEvmWalletClient({
      environmentId: process.env.DYNAMIC_ENVIRONMENT_ID!,
      apiKey: process.env.DYNAMIC_API_KEY!,
    });

    this.provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    );
  }

  async executeOrder(order: Order, proposal: Proposal): Promise<string> {
    if (order.type === OrderType.Send) {
      return this.executeSend(order, proposal);
    }
    if (order.type === OrderType.Swap) {
      return this.executeSwap(order, proposal);
    }
    throw new Error(`Unsupported order type: ${order.type}`);
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async executeSend(order: Order, proposal: Proposal): Promise<string> {
    if (!order.to) throw new Error("send order missing recipient address");
    if (!ethers.isAddress(order.to))
      throw new Error(`invalid recipient address: ${order.to}`);

    const isNative = this.isNativeToken(proposal.token_in);
    const amountWei = await this.parseTokenAmount(
      order.amount_in,
      proposal.token_in,
    );

    const [nonce, feeData] = await Promise.all([
      this.provider.getTransactionCount(this.walletAddress, "pending"),
      this.provider.getFeeData(),
    ]);

    this.assertFeeData(feeData);

    if (isNative) {
      const gasEstimate = await this.provider.estimateGas({
        from: this.walletAddress,
        to: order.to,
        value: amountWei,
      });

      return this.signAndBroadcast({
        to: order.to as `0x${string}`,
        value: amountWei,
        chainId: BASE_CHAIN_ID,
        nonce,
        gas: this.bufferedGas(gasEstimate),
        maxFeePerGas: feeData.maxFeePerGas!,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
        type: "eip1559",
      });
    }

    // ERC-20 transfer — token_in is the contract address
    if (!ethers.isAddress(proposal.token_in)) {
      throw new Error(
        `token_in is not a valid contract address: ${proposal.token_in}`,
      );
    }

    const data = ERC20_INTERFACE.encodeFunctionData("transfer", [
      order.to,
      amountWei,
    ]) as `0x${string}`;

    const gasEstimate = await this.provider.estimateGas({
      from: this.walletAddress,
      to: proposal.token_in,
      data,
    });

    return this.signAndBroadcast({
      to: proposal.token_in as `0x${string}`,
      data,
      value: 0n,
      chainId: BASE_CHAIN_ID,
      nonce,
      gas: this.bufferedGas(gasEstimate),
      maxFeePerGas: feeData.maxFeePerGas!,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
      type: "eip1559",
    });
  }

  // ── Swap ──────────────────────────────────────────────────────────────────

  private async executeSwap(order: Order, proposal: Proposal): Promise<string> {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": process.env.UNISWAP_API_KEY!,
      "x-universal-router-version": "2.0",
    };

    // Amount must be in raw units for the Uniswap API
    const amountWei = await this.parseTokenAmount(
      order.amount_in,
      proposal.token_in,
    );

    // Step 1: check if the router has sufficient token allowance
    const approvalRes = await this.uniswapFetch<{
      approval?: {
        to: string;
        data: string;
        value: string;
        chainId: number;
        gasLimit: string;
      };
    }>(`${UNISWAP_API}/check_approval`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        walletAddress: this.walletAddress,
        token: proposal.token_in,
        amount: amountWei.toString(),
        chainId: BASE_CHAIN_ID,
      }),
    });

    if (approvalRes.approval) {
      const approvalHash = await this.signAndBroadcastUnsigned(
        approvalRes.approval,
      );
      const receipt = await this.provider.waitForTransaction(approvalHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`approval transaction failed: ${approvalHash}`);
      }
    }

    // Step 2: get quote — CLASSIC forces standard AMM routing (no UniswapX auction)
    const quoteRes = await this.uniswapFetch<
      Record<string, unknown> & {
        permitData?: Record<string, unknown> | null;
        // permitTransaction is stripped below — it is only used for browser-side
        // wallet popups and must not be forwarded to /swap
        permitTransaction?: unknown;
      }
    >(`${UNISWAP_API}/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        swapper: this.walletAddress,
        tokenIn: proposal.token_in,
        tokenOut: proposal.token_out,
        tokenInChainId: String(BASE_CHAIN_ID),
        tokenOutChainId: String(BASE_CHAIN_ID),
        amount: amountWei.toString(),
        type: "EXACT_INPUT",
        slippageTolerance: order.slippage_tolerance
          ? Number(order.slippage_tolerance)
          : 0.5,
        routingPreference: "CLASSIC",
      }),
    });

    // Step 3: build swap request — strip permitData/permitTransaction, handle Permit2 if present
    const {
      permitData,
      permitTransaction: _permitTransaction,
      ...cleanQuote
    } = quoteRes;
    const swapBody: Record<string, unknown> = { ...cleanQuote };

    if (permitData) {
      const permit2Sig = await delegatedSignTypedData(this.delegatedClient, {
        ...this.credentials,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typedData: permitData as any,
      });
      swapBody.signature = permit2Sig;
      swapBody.permitData = permitData;
    }

    const swapRes = await this.uniswapFetch<{
      swap?: {
        to: string;
        data: string;
        value: string;
        chainId: number;
        gasLimit: string;
      };
    }>(`${UNISWAP_API}/swap`, {
      method: "POST",
      headers,
      body: JSON.stringify(swapBody),
    });

    if (!swapRes.swap?.data || swapRes.swap.data === "0x") {
      throw new Error("swap.data is empty — quote expired, retry");
    }

    if (swapRes.swap.chainId !== BASE_CHAIN_ID) {
      throw new Error(
        `swap response chainId mismatch: expected ${BASE_CHAIN_ID}, got ${swapRes.swap.chainId}`,
      );
    }

    return this.signAndBroadcastUnsigned(swapRes.swap);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Returns true for native ETH (null, "eth", or the sentinel address) */
  private isNativeToken(token: string | null): boolean {
    if (!token) return true;
    const lower = token.toLowerCase();
    return lower === "eth" || lower === NATIVE_ETH_ADDRESS.toLowerCase();
  }

  /**
   * Converts a human-readable amount to the token's smallest unit.
   * Fetches decimals on-chain for ERC-20s; assumes 18 for native ETH.
   */
  private async parseTokenAmount(
    amount: string,
    token: string | null,
  ): Promise<bigint> {
    if (this.isNativeToken(token)) {
      return ethers.parseEther(amount);
    }
    const contract = new ethers.Contract(
      token!,
      ERC20_INTERFACE,
      this.provider,
    );
    // ethers v6 returns bigint from contract calls; Number() is safe for decimals (≤18)
    const decimals = Number(await contract.decimals());
    return ethers.parseUnits(amount, decimals);
  }

  /** Throws a clear error if EIP-1559 fee data is unavailable from the RPC */
  private assertFeeData(
    feeData: ethers.FeeData,
  ): asserts feeData is ethers.FeeData & {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  } {
    if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
      throw new Error("failed to fetch EIP-1559 fee data from RPC");
    }
  }

  /** Applies a 20% buffer to a gas estimate to reduce out-of-gas failures */
  private bufferedGas(estimate: bigint): bigint {
    return (estimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
  }

  /** Fetches from the Uniswap API and throws on non-2xx responses */
  private async uniswapFetch<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Uniswap API error ${res.status} at ${url}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Sign and broadcast an unsigned tx object returned by the Uniswap API */
  private async signAndBroadcastUnsigned(unsignedTx: {
    to: string;
    data?: string;
    value: string;
    chainId: number;
    gasLimit: string;
  }): Promise<string> {
    const [nonce, feeData] = await Promise.all([
      this.provider.getTransactionCount(this.walletAddress, "pending"),
      this.provider.getFeeData(),
    ]);

    this.assertFeeData(feeData);

    return this.signAndBroadcast({
      to: unsignedTx.to as `0x${string}`,
      ...(unsignedTx.data ? { data: unsignedTx.data as `0x${string}` } : {}),
      value: BigInt(unsignedTx.value),
      chainId: unsignedTx.chainId,
      nonce,
      // Uniswap's gasLimit already accounts for routing complexity; still buffer it
      gas: this.bufferedGas(BigInt(unsignedTx.gasLimit)),
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      type: "eip1559",
    });
  }

  /** Sign a transaction with delegated MPC and broadcast it via ethers */
  private async signAndBroadcast(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: any,
  ): Promise<string> {
    const signedTx = await delegatedSignTransaction(this.delegatedClient, {
      ...this.credentials,
      transaction,
    });

    const txResponse = await this.provider.broadcastTransaction(signedTx);
    return txResponse.hash;
  }
}
