declare module "genesis-runtime/plugin-loader" {
  export function initializePluginManager(options?: Record<string, unknown>): Promise<{
    pluginLoadErrors: string[];
    pluginManager: {
      getCapability(name: string): ((input?: any) => any) | null;
      listTools(): any[];
      executeTool(name: string, args?: Record<string, unknown>, context?: Record<string, unknown>): Promise<any>;
      listPlugins(): any[];
      registerRoutes(): Promise<void>;
      runHook(name: string, payload?: any): Promise<any>;
      shutdown(reason?: string): Promise<void>;
    };
  }>;
}

declare module "genesis-runtime/profile-manager" {
  export function loadActiveProfile(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  export function buildPublicProfile(profile?: Record<string, unknown>): Record<string, unknown>;
  export function getActiveProfileSelection(): Record<string, unknown>;
  export function listAvailableProfiles(options?: Record<string, unknown>): Promise<Array<Record<string, any>>>;
  export function saveProfileSelection(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

declare module "genesis-runtime/admin-security" {
  export function createAdminSecurity(options?: Record<string, unknown>): {
    registerAdminSecurityMiddleware(app: any): void;
    validateAdminRequest(req: any): boolean;
  };
}

declare module "genesis-runtime/http-hooks" {
  export function createHttpHooks(options?: Record<string, unknown>): {
    requestTrackingMiddleware(req: any, res: any, next: any): void;
  };
}
