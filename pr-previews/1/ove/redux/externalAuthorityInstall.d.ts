export default __OVE_EXTERNAL_AUTHORITY__;
declare const __OVE_EXTERNAL_AUTHORITY__: Readonly<{
    install: typeof install;
    uninstall: typeof uninstall;
    isConfigured: typeof isConfigured;
    createMiddleware: typeof createMiddleware;
    getInstalledOptions: typeof getInstalledOptions;
}>;
export function install(options: any): () => void;
export function uninstall(): void;
export function isConfigured(): boolean;
export function createMiddleware(): Function | null;
export function getInstalledOptions(): any;
