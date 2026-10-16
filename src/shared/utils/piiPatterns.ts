/**
 * Shared PII Patterns — GDPR + POPIA
 *
 * Single source of truth for PII detection patterns across request and response sides.
 * Each pattern includes a validator to minimize false positives.
 * Jurisdiction tags enable future opt-in scoping.
 *
 * @module shared/utils/piiPatterns
 */

export type Jurisdiction = "EU" | "ZA" | "US" | "BR" | "GLOBAL";

export interface PIIPatternDef {
  name: string;
  regex: RegExp;
  replacement: string;
  severity: "high" | "medium" | "low";
  jurisdiction: Jurisdiction;
  validator?: (match: string) => boolean;
}

/**
 * IBAN validator (ISO 13616 / MOD-97-10)
 * Supports all SEPA countries + major non-SEPA IBAN users.
 */
function isValidIBAN(iban: string): boolean {
  const cleaned = iban.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(cleaned)) return false;

  // Move first 4 chars to end
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  // Convert letters to numbers (A=10, B=11, ..., Z=35)
  let numeric = "";
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    numeric += code >= 65 ? String(code - 55) : ch;
  }

  // MOD-97 calculation on large number string
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + parseInt(digit, 10)) % 97;
  }
  return remainder === 1;
}

/**
 * Spanish DNI/NIE validator
 * DNI: 8 digits + letter (mod 23)
 * NIE: X/Y/Z + 7 digits + letter (X=0, Y=1, Z=2, then mod 23)
 */
function isValidES_DNI_NIE(value: string): boolean {
  const cleaned = value.toUpperCase().replace(/[\s.-]/g, "");
  if (!/^[XYZ]?\d{8}[A-Z]$/.test(cleaned)) return false;

  let numeric = cleaned.slice(0, -1);
  if (/^[XYZ]/.test(numeric)) {
    numeric = numeric.replace("X", "0").replace("Y", "1").replace("Z", "2");
  }
  const letter = cleaned.slice(-1);
  const letters = "TRWAGMYFPDXBNJZSQVHLCKE";
  const expected = letters[parseInt(numeric, 10) % 23];
  return letter === expected;
}

/**
 * Italian Codice Fiscale validator
 * 16 alphanumeric chars with check character.
 */
function isValidIT_CodiceFiscale(cf: string): boolean {
  const cleaned = cf.toUpperCase().replace(/\s/g, "");
  if (!/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(cleaned)) return false;

  const oddValues: Record<string, number> = {
    "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
    "A": 1, "B": 0, "C": 5, "D": 7, "E": 9, "F": 13, "G": 15, "H": 17, "I": 19, "J": 21,
    "K": 2, "L": 4, "M": 18, "N": 20, "O": 11, "P": 3, "Q": 6, "R": 8, "S": 12, "T": 14,
    "U": 16, "V": 10, "W": 22, "X": 25, "Y": 24, "Z": 23
  };
  const evenValues: Record<string, number> = {
    "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
    "A": 0, "B": 1, "C": 2, "D": 3, "E": 4, "F": 5, "G": 6, "H": 7, "I": 8, "J": 9,
    "K": 10, "L": 11, "M": 12, "N": 13, "O": 14, "P": 15, "Q": 16, "R": 17, "S": 18, "T": 19,
    "U": 20, "V": 21, "W": 22, "X": 23, "Y": 24, "Z": 25
  };
  const checkChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = cleaned[i];
    sum += (i % 2 === 0) ? oddValues[ch] : evenValues[ch];
  }
  return checkChars[sum % 26] === cleaned[15];
}

/**
 * Polish PESEL validator
 * 11 digits: YYMMDDZZZXQ, with checksum weights 1,3,7,9,1,3,7,9,1,3
 */
function isValidPL_PESEL(pesel: string): boolean {
  const digits = pesel.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  if (!/^\d{11}$/.test(digits)) return false;

  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(digits[i], 10) * weights[i];
  }
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(digits[10], 10);
}

/**
 * Dutch BSN validator (Burgerservicenummer)
 * 9 digits, 11-proof (weighted sum modulo 11 == 0)
 * Weights: 9,8,7,6,5,4,3,2,-1
 */
function isValidNL_BSN(bsn: string): boolean {
  const digits = bsn.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  if (!/^\d{9}$/.test(digits)) return false;

  const weights = [9, 8, 7, 6, 5, 4, 3, 2, -1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(digits[i], 10) * weights[i];
  }
  return sum % 11 === 0;
}

/**
 * German Steuer-ID validator (ISO 7064 Mod 11,10)
 * 11 digits with check digit
 */
function isValidDE_SteuerID(id: string): boolean {
  const digits = id.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  if (!/^\d{11}$/.test(digits)) return false;

  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (parseInt(digits[i], 10) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = (11 - product) % 10;
  return check === parseInt(digits[10], 10);
}

/**
 * Swedish personnummer validator (Luhn)
 * Format: YYMMDD-XXXX or YYYYMMDDXXXX
 */
function isValidSE_Personnummer(pnr: string): boolean {
  const cleaned = pnr.replace(/[-+\s]/g, "");
  // Handle both 10-digit (no century) and 12-digit (with century)
  if (cleaned.length === 10) {
    // Validate date part roughly
    if (!/^\d{6}\d{4}$/.test(cleaned)) return false;
    return isValidLuhn(cleaned);
  }
  if (cleaned.length === 12) {
    if (!/^\d{8}\d{4}$/.test(cleaned)) return false;
    return isValidLuhn(cleaned.slice(2)); // Luhn on last 10 digits
  }
  return false;
}

/**
 * South African ID number validator
 * 13 digits: YYMMDDSSSSCAZ
 * - YYMMDD: date of birth
 * - SSSS: sequence (0000-4999 female, 5000-9999 male)
 * - C: citizenship (0=SA citizen, 1=permanent resident)
 * - A: usually 8 or 9 (historical race classification, now fixed)
 * - Z: Luhn check digit (calculated from first 12 digits)
 */
function isValidZA_ID(id: string): boolean {
  const digits = id.replace(/\D/g, "");
  if (digits.length !== 13) return false;
  if (!/^\d{13}$/.test(digits)) return false;

  // Validate date (rough check)
  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  const dd = parseInt(digits.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;

  // Calculate Luhn check digit from first 12 digits and compare to 13th
  const prefix = digits.slice(0, 12);
  const checkDigit = parseInt(digits[12], 10);

  let sum = 0;
  let shouldDouble = false;
  for (let i = prefix.length - 1; i >= 0; i--) {
    let digit = parseInt(prefix[i], 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  const calculatedCheck = (10 - (sum % 10)) % 10;
  return calculatedCheck === checkDigit;
}

/**
 * Luhn algorithm validator
 */
function isValidLuhn(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * South African VAT number validator
 * 10 digits starting with 4
 */
function isValidZA_VAT(vat: string): boolean {
  const cleaned = vat.replace(/\D/g, "");
  if (cleaned.length !== 10) return false;
  return /^4\d{9}$/.test(cleaned);
}

/**
 * South African income tax reference validator
 * 10 digits
 */
function isValidZA_TaxRef(ref: string): boolean {
  const cleaned = ref.replace(/\D/g, "");
  return cleaned.length === 10 && /^\d{10}$/.test(cleaned);
}

/**
 * EU VAT number validator (basic format check per country)
 * Full validation requires VIES service; this does format only.
 */
function isValidEU_VAT(vat: string): boolean {
  const cleaned = vat.toUpperCase().replace(/\s/g, "");
  // Country code + 2-12 alphanumeric
  if (!/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(cleaned)) return false;

  // Basic per-country format checks for major economies
  const country = cleaned.slice(0, 2);
  const number = cleaned.slice(2);
  const formats: Record<string, RegExp> = {
    DE: /^\d{9}$/,           // Germany
    FR: /^[A-Z0-9]{2}\d{9}$/, // France
    IT: /^\d{11}$/,          // Italy
    ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, // Spain
    NL: /^\d{9}B\d{2}$/,     // Netherlands
    BE: /^\d{10}$/,          // Belgium
    AT: /^U\d{8}$/,          // Austria
    PL: /^\d{10}$/,          // Poland
    SE: /^\d{12}$/,          // Sweden
    DK: /^\d{8}$/,           // Denmark
    IE: /^\d{7}[A-Z]{1,2}$/, // Ireland
  };
  const fmt = formats[country];
  return fmt ? fmt.test(number) : true; // accept if unknown country
}

/**
 * All PII patterns with validators.
 * Order matters: more specific patterns should come before generic ones.
 */
export const PII_PATTERNS: PIIPatternDef[] = [
  // ── GDPR / EU Patterns ──

  {
    name: "iban",
    // IBAN: 2 letters country + 2 check digits + up to 30 alphanum (no spaces in regex, spaces handled by validator)
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/gi,
    replacement: "[IBAN_REDACTED]",
    severity: "high",
    jurisdiction: "EU",
    validator: isValidIBAN,
  },
  {
    name: "eu_vat",
    regex: /\b[A-Z]{2}[A-Z0-9]{2,12}\b/g,
    replacement: "[EU_VAT_REDACTED]",
    severity: "medium",
    jurisdiction: "EU",
    validator: isValidEU_VAT,
  },
  {
    name: "es_dni_nie",
    // Spanish DNI: 8 digits + letter; NIE: X/Y/Z + 7 digits + letter
    regex: /\b[XYZ]?\d{8}[A-Z]\b/gi,
    replacement: "[ES_DNI_REDACTED]",
    severity: "high",
    jurisdiction: "EU",
    validator: isValidES_DNI_NIE,
  },
  {
    name: "it_codice_fiscale",
    regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi,
    replacement: "[IT_CF_REDACTED]",
    severity: "high",
    jurisdiction: "EU",
    validator: isValidIT_CodiceFiscale,
  },
  {
    name: "pl_pesel",
    regex: /\b\d{11}\b/g,
    replacement: "[PL_PESEL_REDACTED]",
    severity: "high",
    jurisdiction: "EU",
    validator: isValidPL_PESEL,
  },
  {
    name: "nl_bsn",
    regex: /\b\d{9}\b/g,
    replacement: "[NL_BSN_REDACTED]",
    severity: "high",
    jurisdiction: "EU",
    validator: isValidNL_BSN,
  },
  {
    name: "de_steuer_id",
    regex: /\b\d{11}\b/g,
    replacement: "[DE_STEUERID_REDACTED]",
    severity: "high",
    jurisdiction: "EU",
    validator: isValidDE_SteuerID,
  },
  {
    name: "se_personnummer",
    regex: /\b\d{6}[-+]?\d{4}\b/g,
    replacement: "[SE_PNR_REDACTED]",
    severity: "high",
    jurisdiction: "EU",
    validator: isValidSE_Personnummer,
  },

  // ── POPIA / South Africa Patterns ──

  {
    name: "za_id",
    regex: /\b\d{13}\b/g,
    replacement: "[ZA_ID_REDACTED]",
    severity: "high",
    jurisdiction: "ZA",
    validator: isValidZA_ID,
  },
  {
    name: "za_phone",
    regex: /\b(?:\+?27|0)[\s-]?(?:1[0-9]|2[1-9]|3[1-9]|4[0-9]|5[1-9]|7[1-9]|8[1-9])[\s-]?\d{3}[\s-]?\d{4}\b/g,
    replacement: "[ZA_PHONE_REDACTED]",
    severity: "medium",
    jurisdiction: "ZA",
    validator: undefined, // format-based only
  },
  {
    name: "za_vat",
    regex: /\b4\d{9}\b/g,
    replacement: "[ZA_VAT_REDACTED]",
    severity: "medium",
    jurisdiction: "ZA",
    validator: isValidZA_VAT,
  },
  {
    name: "za_tax_ref",
    regex: /\b\d{10}\b/g,
    replacement: "[ZA_TAXREF_REDACTED]",
    severity: "medium",
    jurisdiction: "ZA",
    validator: isValidZA_TaxRef,
  },

  // ── Existing patterns (US / BR / GLOBAL) preserved ──
  // Note: these are kept for backward compatibility; the actual regexes
  // are defined in the consumer files (inputSanitizer uses \b boundaries,
  // piiSanitizer uses lookbehind/lookahead). This module exports the
  // validator functions and jurisdiction metadata; the consumers still
  // define their own regexes with appropriate boundaries.
];

/**
 * Get patterns filtered by jurisdiction (for future opt-in scoping).
 */
export function getPatternsByJurisdiction(jurisdictions: Jurisdiction[]): PIIPatternDef[] {
  return PII_PATTERNS.filter((p) => jurisdictions.includes(p.jurisdiction));
}

/**
 * Get all patterns with validators (for response side which runs validators).
 */
export function getValidatedPatterns(): PIIPatternDef[] {
  return PII_PATTERNS.filter((p) => p.validator !== undefined);
}

/**
 * Export validators for direct use.
 */
export const validators = {
  isValidIBAN,
  isValidES_DNI_NIE,
  isValidIT_CodiceFiscale,
  isValidPL_PESEL,
  isValidNL_BSN,
  isValidDE_SteuerID,
  isValidSE_Personnummer,
  isValidZA_ID,
  isValidLuhn,
  isValidZA_VAT,
  isValidZA_TaxRef,
  isValidEU_VAT,
};

// Also export each validator as a named export for direct imports
export {
  isValidIBAN,
  isValidES_DNI_NIE,
  isValidIT_CodiceFiscale,
  isValidPL_PESEL,
  isValidNL_BSN,
  isValidDE_SteuerID,
  isValidSE_Personnummer,
  isValidZA_ID,
  isValidLuhn,
  isValidZA_VAT,
  isValidZA_TaxRef,
  isValidEU_VAT,
};