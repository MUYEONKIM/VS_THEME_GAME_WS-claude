export type RuntimeBindings = {
  MEMORY_IMAGES?: KVNamespace;
  STATS?: D1Database;
  UPLOAD_PASSWORD?: string;
};

export async function getRuntimeBindings(): Promise<RuntimeBindings> {
  try {
    const moduleName = "cloudflare:workers";
    const runtime = await import(/* @vite-ignore */ moduleName) as { env?: RuntimeBindings };
    if (runtime.env) return runtime.env;
  } catch {
    // The standalone Node server does not provide Cloudflare bindings.
  }

  return {
    UPLOAD_PASSWORD: process.env.UPLOAD_PASSWORD,
  };
}
