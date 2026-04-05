declare module "@dynamic-labs-wallet/node-evm" {
  import type { TransactionSerializable, TypedData } from "viem";

  export interface DelegatedEvmWalletClientConfig {
    environmentId: string;
    apiKey: string;
    baseApiUrl?: string;
    baseMPCRelayApiUrl?: string;
    debug?: boolean;
  }

  export interface DelegatedEvmWalletClient {
    environmentId: string;
    apiKey: string;
  }

  export interface ServerKeyShare {
    pubkey: { pubkey: Uint8Array };
    secretShare: string;
  }

  export interface DelegatedSignParams {
    walletId: string;
    walletApiKey: string;
    keyShare: ServerKeyShare;
  }

  export function createDelegatedEvmWalletClient(
    config: DelegatedEvmWalletClientConfig
  ): DelegatedEvmWalletClient;

  export function delegatedSignMessage(
    client: DelegatedEvmWalletClient,
    params: DelegatedSignParams & { message: string }
  ): Promise<string>;

  export function delegatedSignTransaction(
    client: DelegatedEvmWalletClient,
    params: DelegatedSignParams & { transaction: TransactionSerializable }
  ): Promise<string>;

  export function delegatedSignTypedData(
    client: DelegatedEvmWalletClient,
    params: DelegatedSignParams & { typedData: TypedData }
  ): Promise<string>;
}
