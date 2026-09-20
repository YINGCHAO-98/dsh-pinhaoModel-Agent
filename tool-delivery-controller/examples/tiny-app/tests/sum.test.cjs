const { test } = require('node:test');
const assert = require('node:assert/strict');
const sum = require('../src/sum.cjs');
test('adds positive numbers', () => assert.equal(sum(2, 3), 5));
test('adds negative numbers', () => assert.equal(sum(-2, -3), -5));
