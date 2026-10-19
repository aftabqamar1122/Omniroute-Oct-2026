import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { IntlMessageFormat } from "intl-messageformat";

const root = new URL("../../src/i18n/messages/", import.meta.url);
const catalogs = Object.fromEntries(
  readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file.slice(0, -5), JSON.parse(readFileSync(new URL(file, root), "utf8"))])
);
const keys = [
  "healthAction",
  "healthTitle",
  "healthDrag",
  "healthDragPosition",
  "healthResetOrder",
  "healthPool",
  "healthOtherPool",
  "healthIncluded",
  "healthBannerUnavailable",
  "healthBannerAvailable",
  "healthLegendOk",
  "healthLegendCooldown",
  "healthLegendAction",
  "healthLegendPartial",
  "healthWaited",
  "healthWait",
  "healthFastest",
  "healthRatio",
  "healthCd5",
  "healthCdw",
  "healthAccountHint",
  "healthAvailable",
  "healthRestricted",
  "healthUnavailable",
  "healthCooldown",
  "healthQuotaExhausted",
  "healthRecovery",
  "noQuotaData",
  "healthQuotaError",
  "healthNoRuntime",
  "healthPreviousSnapshot",
  "healthPreviousFailure",
  "healthAwaitingSync",
  "healthVerdictUnavailable",
  "healthSummaryFailed",
  "healthRuntimeObserved",
  "healthQuotaObserved",
  "healthOldestQuota",
  "healthRecoveryUnknown",
  "healthDetailsHint",
  "healthFiveHour",
  "healthOverall",
  "healthRecentSuccessBypass",
  "healthPurchasedBalanceBypass",
  "healthCutoffAtRequest",
];
// Quantity-sensitive usage/common keys used by the availability overview.
// active is only the ratio denominator; available controls agreement. Percentages,
// remaining quota, timestamps and durations arrive already localized by useHealthText.
const quantityKeys = {
  healthIncluded: "count",
  healthBannerUnavailable: "count",
  healthBannerAvailable: "count",
  healthRatio: "available",
} as const;

for (const [locale, catalog] of Object.entries(catalogs)) {
  for (const [key, argument] of Object.entries(quantityKeys)) {
    test(`${locale}.usage.${key} covers every cardinal plural category`, () => {
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      const message = new IntlMessageFormat(catalog.usage[key], locale);
      if (categories.length === 1) return;
      const plural = message
        .getAst()
        .find((element) => element.type === 6 && element.value === argument);
      assert.ok(plural && plural.type === 6, `${locale}.${key} needs ${argument}, plural`);
      assert.equal(plural.pluralType, "cardinal");
      for (const category of categories) {
        assert.ok(plural.options[category], `${locale}.${key} missing ${category}`);
      }
      assert.ok(plural.options.other, `${locale}.${key} missing other`);
    });
  }
}

for (const locale of ["de", "fr", "ru", "ar", "pl"]) {
  for (const [key, argument] of Object.entries(quantityKeys)) {
    test(`${locale}.usage.${key} formats 1, 2 and 5 with localized agreement`, () => {
      const message = new IntlMessageFormat(catalogs[locale].usage[key], locale);
      const results = [1, 2, 5].map((count) =>
        message.format({ count, available: count, active: 9 })
      );
      assert.ok(new Set(results).size > 1, `${locale}.${key}: ${results.join(" | ")}`);
      // Numbers alone must not make a broken, single-form translation pass.
      if (argument === "count") {
        const forms = results.map((result) => String(result).replace(/\p{N}+/gu, "#"));
        assert.ok(
          new Set(forms).size > 1,
          `${locale}.${key} never changes agreement for ${argument}`
        );
      }
    });
  }
}

const obsolete = ["healthObservationUnavailable", "statCritical", "statAlert", "statHealthy"];
function flatten(node: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(node).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return value && typeof value === "object"
        ? Object.entries(flatten(value as Record<string, unknown>, path))
        : [[path, value as string]];
    })
  );
}
test("all 67 catalogs have identical key sets, no placeholders, and no obsolete availability keys", () => {
  assert.equal(Object.keys(catalogs).length, 67);
  const expected = Object.keys(flatten(catalogs.en)).sort();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const messages = flatten(catalog);
    assert.deepEqual(Object.keys(messages).sort(), expected, locale);
    for (const [key, value] of Object.entries(messages))
      assert.ok(!value.includes("__MISSING__"), `${locale}.${key}`);
    for (const key of obsolete)
      assert.equal(catalog.usage[key], undefined, `${locale}.${key} is obsolete`);
  }
});
test("availability copy is translated in every locale and compiles as ICU", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      const value = catalog.usage[key];
      assert.equal(typeof value, "string", `${locale}.${key}`);
      assert.ok(value.trim().length > 0, `${locale}.${key}`);
      if (locale !== "en")
        assert.notEqual(
          value,
          catalogs.en.usage[key],
          `${locale}.${key} must not use English fallback`
        );
      assert.doesNotThrow(() => new IntlMessageFormat(value, locale), `${locale}.${key}`);
    }
  }
  assert.equal(catalogs["zh-CN"].usage.healthAvailable, "可用");
  assert.equal(catalogs["zh-CN"].usage.healthRestricted, "部分受限");
  assert.equal(catalogs.en.usage.healthRestricted, "Partially restricted");
});
