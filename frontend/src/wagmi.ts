import { http, createConfig } from 'wagmi';
import { mainnet, sepolia, localhost } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

export const config = createConfig({
  chains: [sepolia, localhost, mainnet],
  connectors: [
    injected(),
  ],
  transports: {
    [sepolia.id]: http(),
    [localhost.id]: http('http://127.0.0.1:8545'),
    [mainnet.id]: http(),
  },
});
