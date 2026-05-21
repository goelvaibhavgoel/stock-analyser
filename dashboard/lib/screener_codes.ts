// NSE codes where the screener.in slug differs from the NSE code
export const SCREENER_CODE_OVERRIDES: Record<string, string> = {
  HESTER: "HESTERBIO",
};

export function screenerCode(nse_code: string): string {
  return SCREENER_CODE_OVERRIDES[nse_code] ?? nse_code;
}
