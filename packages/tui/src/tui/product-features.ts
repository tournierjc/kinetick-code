export interface TuiProductFeatures {
  readonly queue: boolean;
}

export const KCODE_MVP_TUI_PRODUCT_FEATURES: TuiProductFeatures = Object.freeze({
  queue: true,
});

export function resolveTuiProductFeatures(
  overrides: Partial<TuiProductFeatures> | undefined,
): TuiProductFeatures {
  return {
    ...KCODE_MVP_TUI_PRODUCT_FEATURES,
    ...overrides,
  };
}
