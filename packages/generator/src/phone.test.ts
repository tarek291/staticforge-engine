import test from "node:test";
import assert from "node:assert/strict";
import { toTelHref } from "@staticforge/core";

test("toTelHref: spaced international number becomes tel:+digits", () => {
  assert.equal(toTelHref("+49 203 1234567"), "tel:+492031234567");
  assert.equal(toTelHref("+1 555 0100"), "tel:+15550100");
});

test("toTelHref: separators (parens, dashes, spaces) are normalized", () => {
  assert.equal(toTelHref("+49 (203) 123-4567"), "tel:+492031234567");
});

test("toTelHref: missing leading + returns null", () => {
  assert.equal(toTelHref("49 203 1234567"), null);
});

test("toTelHref: too-short number returns null", () => {
  assert.equal(toTelHref("+1 2345"), null);
});

test("toTelHref: too-long number returns null", () => {
  assert.equal(toTelHref("+1 2345678901234567"), null);
});

test("toTelHref: junk text returns null", () => {
  assert.equal(toTelHref("Call us"), null);
  assert.equal(toTelHref("+abc"), null);
});
