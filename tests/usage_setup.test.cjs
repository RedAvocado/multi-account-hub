'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseConfig} = require('../scripts/configure-t3-usage.cjs');

test('usage upgrade changes only the selected hub auth flag and preserves routing and other sections', () => {
  const key = 'a'.repeat(43);
  const input = `model_provider = "dittodub-hub"
model = "existing-model"

[model_providers.dittodub-hub]
name = "Hub"
base_url = "https://hub.example.com/v1"
requires_openai_auth = false
experimental_bearer_token = "${key}"

[model_providers.other]
requires_openai_auth = false
`;
  const origins = ['https://hub.example.com', 'https://old-hub.example.com'];
  const parsed = parseConfig(input, origins);
  assert.equal(parsed.key, key);
  assert.equal(parsed.text, input.replace('requires_openai_auth = false', 'requires_openai_auth = true'));
  assert.equal(parseConfig(parsed.text, origins).text, parsed.text, 'upgrade must be idempotent');
  assert.equal(parseConfig(input.replace('https://hub.example.com/v1', 'https://old-hub.example.com/v1'), origins).key, key);
  assert.throws(() => parseConfig(input.replace('https://hub.example.com/v1', 'https://example.com/v1'), origins));
  assert.throws(() => parseConfig(input), 'an unrendered script recognizes no hub');
  assert.throws(() => parseConfig(input.replace(key, 'not-a-key'), origins));
  assert.throws(() => parseConfig(input.replace('model_provider = "dittodub-hub"', 'model_provider = "other"'), origins));
});
