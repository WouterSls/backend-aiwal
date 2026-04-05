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

const log = (tag: string, msg: string, data?: unknown) => {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${ts}] [TRADER] [${tag}] ${msg}`, data);
  } else {
    console.log(`[${ts}] [TRADER] [${tag}] ${msg}`);
  }
};

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
    log("INIT", `Initializing Trader for wallet ${walletAddress}`);
    log("INIT", `Wallet ID: ${walletId}`);
    log("INIT", `Dynamic environment ID: ${process.env.DYNAMIC_ENVIRONMENT_ID}`);
    log("INIT", `Base RPC URL: ${process.env.BASE_RPC_URL ?? "https://mainnet.base.org (default)"}`);

    this.credentials = { walletId, walletApiKey, keyShare };
    this.walletAddress = walletAddress;

    log("INIT", "Creating delegated EVM wallet client...");
    this.delegatedClient = createDelegatedEvmWalletClient({
      environmentId: process.env.DYNAMIC_ENVIRONMENT_ID!,
      apiKey: process.env.DYNAMIC_API_KEY!,
    });
    log("INIT", "Delegated EVM wallet client created successfully");

    log("INIT", "Creating ethers JSON RPC provider...");
    this.provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    );
    log("INIT", "Trader initialization complete");
  }

  async executeOrder(order: Order, proposal: Proposal): Promise<string> {
    log("EXECUTE", `Starting order execution — order ID: ${order.id}, type: ${order.type}`);
    log("EXECUTE", `Proposal ID: ${proposal.id}, title: "${proposal.title}"`);
    log("EXECUTE", `Token in: ${proposal.token_in}, token out: ${proposal.token_out}`);
    log("EXECUTE", `Amount in: ${order.amount_in}`);
    if (order.type === OrderType.Send) {
      log("EXECUTE", `Routing to SEND handler — recipient: ${order.to}`);
      return this.executeSend(order, proposal);
    }
    if (order.type === OrderType.Swap) {
      log("EXECUTE", `Routing to SWAP handler — slippage: ${order.slippage_tolerance ?? "0.5 (default)"}%`);
      return this.executeSwap(order, proposal);
    }
    log("EXECUTE", `ERROR: Unsupported order type "${order.type}"`);
    throw new Error(`Unsupported order type: ${order.type}`);
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async executeSend(order: Order, proposal: Proposal): Promise<string> {
    log("SEND", "Validating recipient address...");
    if (!order.to) {
      log("SEND", "ERROR: send order missing recipient address");
      throw new Error("send order missing recipient address");
    }
    if (!ethers.isAddress(order.to)) {
      log("SEND", `ERROR: invalid recipient address: ${order.to}`);
      throw new Error(`invalid recipient address: ${order.to}`);
    }
    log("SEND", `Recipient address valid: ${order.to}`);

    const isNative = this.isNativeToken(proposal.token_in);
    log("SEND", `Token type: ${isNative ? "native ETH" : `ERC-20 (${proposal.token_in})`}`);

    log("SEND", `Parsing token amount: ${order.amount_in}...`);
    const amountWei = await this.parseTokenAmount(
      order.amount_in,
      proposal.token_in,
    );
    log("SEND", `Parsed amount in wei: ${amountWei.toString()}`);

    log("SEND", "Fetching nonce and fee data in parallel...");
    const [nonce, feeData] = await Promise.all([
      this.provider.getTransactionCount(this.walletAddress, "pending"),
      this.provider.getFeeData(),
    ]);
    log("SEND", `Nonce: ${nonce}`);
    log("SEND", `Fee data — maxFeePerGas: ${feeData.maxFeePerGas?.toString()}, maxPriorityFeePerGas: ${feeData.maxPriorityFeePerGas?.toString()}, gasPrice: ${feeData.gasPrice?.toString()}`);

    this.assertFeeData(feeData);
    log("SEND", "EIP-1559 fee data validated successfully");

    if (isNative) {
      log("SEND", `Estimating gas for native ETH transfer to ${order.to}...`);
      const gasEstimate = await this.provider.estimateGas({
        from: this.walletAddress,
        to: order.to,
        value: amountWei,
      });
      const buffered = this.bufferedGas(gasEstimate);
      log("SEND", `Gas estimate: ${gasEstimate.toString()}, buffered (120%): ${buffered.toString()}`);

      log("SEND", "Signing and broadcasting native ETH transfer...");
      const tx = {
        to: order.to as `0x${string}`,
        value: amountWei,
        chainId: BASE_CHAIN_ID,
        nonce,
        gas: buffered,
        maxFeePerGas: feeData.maxFeePerGas!,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
        type: "eip1559",
      };
      log("SEND", "Transaction object:", { to: tx.to, value: tx.value.toString(), chainId: tx.chainId, nonce: tx.nonce, gas: tx.gas.toString() });
      const txHash = await this.signAndBroadcast(tx);
      log("SEND", `Native ETH transfer submitted — tx hash: ${txHash}`);
      return txHash;
    }

    // ERC-20 transfer — token_in is the contract address
    log("SEND", "Validating ERC-20 contract address...");
    if (!ethers.isAddress(proposal.token_in)) {
      log("SEND", `ERROR: token_in is not a valid contract address: ${proposal.token_in}`);
      throw new Error(
        `token_in is not a valid contract address: ${proposal.token_in}`,
      );
    }
    log("SEND", `ERC-20 contract address valid: ${proposal.token_in}`);

    log("SEND", `Encoding ERC-20 transfer(${order.to}, ${amountWei.toString()})...`);
    const data = ERC20_INTERFACE.encodeFunctionData("transfer", [
      order.to,
      amountWei,
    ]) as `0x${string}`;
    log("SEND", `Encoded calldata (first 10 chars): ${data.slice(0, 10)}...`);

    log("SEND", `Estimating gas for ERC-20 transfer to contract ${proposal.token_in}...`);
    const gasEstimate = await this.provider.estimateGas({
      from: this.walletAddress,
      to: proposal.token_in,
      data,
    });
    const buffered = this.bufferedGas(gasEstimate);
    log("SEND", `Gas estimate: ${gasEstimate.toString()}, buffered (120%): ${buffered.toString()}`);

    log("SEND", "Signing and broadcasting ERC-20 transfer...");
    const tx = {
      to: proposal.token_in as `0x${string}`,
      data,
      value: 0n,
      chainId: BASE_CHAIN_ID,
      nonce,
      gas: buffered,
      maxFeePerGas: feeData.maxFeePerGas!,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
      type: "eip1559",
    };
    log("SEND", "Transaction object:", { to: tx.to, value: tx.value.toString(), chainId: tx.chainId, nonce: tx.nonce, gas: tx.gas.toString() });
    const txHash = await this.signAndBroadcast(tx);
    log("SEND", `ERC-20 transfer submitted — tx hash: ${txHash}`);
    return txHash;
  }

  // ── Swap ──────────────────────────────────────────────────────────────────

  private async executeSwap(order: Order, proposal: Proposal): Promise<string> {
    log("SWAP", `Starting swap — ${proposal.token_in} → ${proposal.token_out}`);

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": process.env.UNISWAP_API_KEY!,
      "x-universal-router-version": "2.0",
    };

    // Amount must be in raw units for the Uniswap API
    log("SWAP", `Parsing token amount: ${order.amount_in}...`);
    const amountWei = await this.parseTokenAmount(
      order.amount_in,
      proposal.token_in,
    );
    log("SWAP", `Parsed amount in wei: ${amountWei.toString()}`);

    // Step 1: check if the router has sufficient token allowance
    log("SWAP", `[Step 1/4] Checking token approval — wallet: ${this.walletAddress}, token: ${proposal.token_in}, amount: ${amountWei.toString()}`);
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
      log("SWAP", "Approval required — signing and broadcasting approval transaction...");
      log("SWAP", "Approval tx details:", { to: approvalRes.approval.to, gasLimit: approvalRes.approval.gasLimit, chainId: approvalRes.approval.chainId });
      const approvalHash = await this.signAndBroadcastUnsigned(
        approvalRes.approval,
      );
      log("SWAP", `Approval tx submitted — hash: ${approvalHash}. Waiting for confirmation...`);
      const receipt = await this.provider.waitForTransaction(approvalHash);
      if (!receipt || receipt.status !== 1) {
        log("SWAP", `ERROR: Approval transaction failed — hash: ${approvalHash}, status: ${receipt?.status}`);
        throw new Error(`approval transaction failed: ${approvalHash}`);
      }
      log("SWAP", `Approval confirmed — block: ${receipt.blockNumber}, gasUsed: ${receipt.gasUsed.toString()}`);
    } else {
      log("SWAP", "No approval needed — router already has sufficient allowance");
    }

    // Step 2: get quote — CLASSIC forces standard AMM routing (no UniswapX auction)
    const slippage = order.slippage_tolerance ? Number(order.slippage_tolerance) : 0.5;
    log("SWAP", `[Step 2/4] Fetching Uniswap quote — tokenIn: ${proposal.token_in}, tokenOut: ${proposal.token_out}, amount: ${amountWei.toString()}, slippage: ${slippage}%, routing: CLASSIC`);
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
        slippageTolerance: slippage,
        routingPreference: "CLASSIC",
      }),
    });
    log("SWAP", "Quote received successfully");
    log("SWAP", `Quote includes permitData: ${!!quoteRes.permitData}`);

    // Step 3: build swap request — strip permitData/permitTransaction, handle Permit2 if present
    log("SWAP", "[Step 3/4] Building swap request body...");
    const {
      permitData,
      permitTransaction: _permitTransaction,
      ...cleanQuote
    } = quoteRes;
    const swapBody: Record<string, unknown> = { ...cleanQuote };

    if (permitData) {
      log("SWAP", "Permit2 data present — signing typed data with delegated MPC wallet...");
      const permit2Sig = await delegatedSignTypedData(this.delegatedClient, {
        ...this.credentials,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typedData: permitData as any,
      });
      log("SWAP", `Permit2 signature obtained (first 10 chars): ${permit2Sig.slice(0, 10)}...`);
      swapBody.signature = permit2Sig;
      swapBody.permitData = permitData;
    } else {
      log("SWAP", "No Permit2 required — using standard approval flow");
    }

    log("SWAP", "[Step 4/4] Submitting swap request to Uniswap API...");
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
      log("SWAP", "ERROR: swap.data is empty — quote likely expired");
      throw new Error("swap.data is empty — quote expired, retry");
    }

    if (swapRes.swap.chainId !== BASE_CHAIN_ID) {
      log("SWAP", `ERROR: chainId mismatch — expected ${BASE_CHAIN_ID}, got ${swapRes.swap.chainId}`);
      throw new Error(
        `swap response chainId mismatch: expected ${BASE_CHAIN_ID}, got ${swapRes.swap.chainId}`,
      );
    }

    log("SWAP", "Swap tx received from Uniswap API:", { to: swapRes.swap.to, gasLimit: swapRes.swap.gasLimit, chainId: swapRes.swap.chainId, value: swapRes.swap.value });
    log("SWAP", "Signing and broadcasting swap transaction...");
    const txHash = await this.signAndBroadcastUnsigned(swapRes.swap);
    log("SWAP", `Swap submitted — tx hash: ${txHash}`);
    return txHash;
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
      log("PARSE_AMOUNT", `Native ETH — parsing ${amount} ETH as wei (18 decimals)`);
      return ethers.parseEther(amount);
    }
    log("PARSE_AMOUNT", `ERC-20 token ${token} — fetching decimals on-chain...`);
    const contract = new ethers.Contract(
      token!,
      ERC20_INTERFACE,
      this.provider,
    );
    // ethers v6 returns bigint from contract calls; Number() is safe for decimals (≤18)
    const decimals = Number(await contract.decimals());
    log("PARSE_AMOUNT", `Token decimals: ${decimals} — parsing ${amount} with ${decimals} decimals`);
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
      log("FEE_DATA", "ERROR: EIP-1559 fee data missing from RPC response");
      throw new Error("failed to fetch EIP-1559 fee data from RPC");
    }
  }

  /** Applies a 20% buffer to a gas estimate to reduce out-of-gas failures */
  private bufferedGas(estimate: bigint): bigint {
    return (estimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
  }

  /** Fetches from the Uniswap API and throws on non-2xx responses */
  private async uniswapFetch<T>(url: string, init: RequestInit): Promise<T> {
    log("UNISWAP_FETCH", `→ ${init.method ?? "GET"} ${url}`);
    const res = await fetch(url, init);
    log("UNISWAP_FETCH", `← ${res.status} ${res.statusText} from ${url}`);
    if (!res.ok) {
      const body = await res.text();
      log("UNISWAP_FETCH", `ERROR body: ${body}`);
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
    log("SIGN_BROADCAST", `Fetching nonce and fee data for unsigned tx to ${unsignedTx.to}...`);
    const [nonce, feeData] = await Promise.all([
      this.provider.getTransactionCount(this.walletAddress, "pending"),
      this.provider.getFeeData(),
    ]);
    log("SIGN_BROADCAST", `Nonce: ${nonce}, maxFeePerGas: ${feeData.maxFeePerGas?.toString()}, maxPriorityFeePerGas: ${feeData.maxPriorityFeePerGas?.toString()}`);

    this.assertFeeData(feeData);

    const buffered = this.bufferedGas(BigInt(unsignedTx.gasLimit));
    log("SIGN_BROADCAST", `Gas — Uniswap limit: ${unsignedTx.gasLimit}, buffered (120%): ${buffered.toString()}`);

    const tx = {
      to: unsignedTx.to as `0x${string}`,
      ...(unsignedTx.data ? { data: unsignedTx.data as `0x${string}` } : {}),
      value: BigInt(unsignedTx.value),
      chainId: unsignedTx.chainId,
      nonce,
      gas: buffered,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      type: "eip1559",
    };
    log("SIGN_BROADCAST", "Built transaction:", { to: tx.to, value: tx.value.toString(), chainId: tx.chainId, nonce: tx.nonce, gas: tx.gas.toString() });

    return this.signAndBroadcast(tx);
  }

  /** Sign a transaction with delegated MPC and broadcast it via ethers */
  private async signAndBroadcast(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: any,
  ): Promise<string> {
    log("SIGN_BROADCAST", `Signing transaction via delegated MPC — walletId: ${this.credentials.walletId}`);
    const signedTx = await delegatedSignTransaction(this.delegatedClient, {
      ...this.credentials,
      transaction,
    });
    log("SIGN_BROADCAST", `Transaction signed successfully (raw tx length: ${signedTx.length} chars)`);

    log("SIGN_BROADCAST", "Broadcasting signed transaction to Base network...");
    const txResponse = await this.provider.broadcastTransaction(signedTx);
    log("SIGN_BROADCAST", `Transaction broadcast — hash: ${txResponse.hash}`);
    return txResponse.hash;
  }
}
