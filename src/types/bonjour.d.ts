declare module 'bonjour' {
  interface Service {
    name: string;
    type: string;
    port: number;
    txt: Record<string, string>;
    addresses?: string[];
  }

  interface BonjourService {
    publish(options: {
      name: string;
      type: string;
      port: number;
      txt?: Record<string, string>;
      addresses?: string[];
    }): void;
    find(query: { type: string }, callback: (service: Service) => void): { stop: () => void };
    destroy(): void;
  }

  function create(): BonjourService;
  export = create;
}
