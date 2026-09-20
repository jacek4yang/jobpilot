export interface JobLocation {
  readonly city: string;
  readonly district?: string;
  readonly businessArea?: string;
  /** Raw location text as displayed, kept for explanation and debugging. */
  readonly raw: string;
}

const SEPARATORS = /[·•\-\s|,，/]+/;

export const parseLocation = (raw: string | undefined | null): JobLocation => {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    return { city: "", raw: "" };
  }

  const parts = text.split(SEPARATORS).filter((part) => part.length > 0);
  const city = parts[0] ?? "";
  const district = parts[1];
  const businessArea = parts[2];

  return {
    city,
    raw: text,
    ...(district === undefined ? {} : { district }),
    ...(businessArea === undefined ? {} : { businessArea }),
  };
};

/**
 * Normalizes a city name for comparison.
 * Handles the common `北京市` / `北京` mismatch without guessing beyond suffix
 * stripping.
 */
export const normalizeCity = (city: string): string =>
  city
    .trim()
    .replace(/[市区县]$/, "")
    .toLowerCase();
