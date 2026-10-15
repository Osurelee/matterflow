#!/usr/bin/env node
/** M4-05 media-token rendering contract (API storage/access is exercised by test-m1 isolated integration suite). */
import assert from 'node:assert/strict';
import { assetIdFromToken, canonicalBody, isAssetToken, renderSafeHtml } from '../src/domain/body.ts';
const id='123e4567-e89b-42d3-a456-426614174000';
assert.equal(isAssetToken(`asset:${id}`),true);
assert.equal(assetIdFromToken(`asset:${id}`),id);
assert.equal(isAssetToken('asset:../../private'),false);
const source=`![receipt](asset:${id})`;
const html=renderSafeHtml(source,(assetId)=>`/tasks/api/assets/${assetId}/content`);
assert.match(html,new RegExp(`<img class="bodyAssetImage" src="/tasks/api/assets/${id}/content"`));
assert.match(html,/alt="receipt"/);
assert.equal(canonicalBody(source),source);
const unsafe=renderSafeHtml('![outside](javascript:alert(1))');
assert.doesNotMatch(unsafe,/<img\b/);
assert.doesNotMatch(unsafe,/javascript:/);
console.log('M4-05 media token/rendering contract: PASS (7 checks)');
