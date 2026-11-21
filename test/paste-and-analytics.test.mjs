import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareReviewTask, reviewInputValid, reviewTextLength } from '../src/review-task.ts';
import { analyticsConfigured, readAnalyticsConsent, saveAnalyticsConsent, CONSENT_STORAGE_KEY, trackAnalyticsEvent } from '../src/analytics.ts';

const task = { title:'', description:'Add dark mode to web and mobile.\nFollow the approved Figma file.', type:'General', domain:'Other', criteria:'', context:'' };

test('paste-only tasks derive a truthful API title without requiring a separate field', () => {
  const prepared = prepareReviewTask(task);
  assert.equal(prepared.title, 'Add dark mode to web and mobile.');
  assert.equal(prepared.description, task.description);
  assert.ok(reviewInputValid(task));
});

test('an explicit title is preserved instead of being regenerated', () => {
  assert.equal(prepareReviewTask({ ...task, title:'Implement themes' }).title, 'Implement themes');
});

test('first non-empty source line is used and constrained to 120 characters', () => {
  const s = '  \n\n' + 'x'.repeat(250) + '\nMore details';
  assert.equal(prepareReviewTask({ ...task, description:s }).title, 'x'.repeat(120));
});

test('empty, oversized and over-budget text is rejected', () => {
  assert.equal(reviewInputValid({ ...task, description:'   ' }), false);
  assert.equal(reviewInputValid({ ...task, description:'a'.repeat(6501) }), false);
  assert.equal(reviewInputValid({ ...task, description:'a'.repeat(6500), criteria:'b'.repeat(1200), context:'c'.repeat(200) }), false);
  assert.equal(reviewInputValid(task), true);
  assert.equal(reviewTextLength(task), prepareReviewTask(task).title.length + task.description.length);
});

test('no analytics IDs means tracking stays disabled without explicit opt-in', () => {
  assert.equal(analyticsConfigured, false);
  assert.doesNotThrow(() => trackAnalyticsEvent('review_started'));
});

test('consent remains unset by default and accepts only defined choices', () => {
  const store = new Map();
  const fake = {
    getItem(key) { return store.get(key) ?? null; },
    setItem(key, value) { store.set(key, value); },
  };
  assert.equal(readAnalyticsConsent(fake), 'unset');
  saveAnalyticsConsent('declined', fake);
  assert.equal(readAnalyticsConsent(fake), 'declined');
  saveAnalyticsConsent('accepted', fake);
  assert.equal(readAnalyticsConsent(fake), 'accepted');
  assert.equal(store.get(CONSENT_STORAGE_KEY), 'accepted');
  fake.setItem(CONSENT_STORAGE_KEY, 'incorrect');
  assert.equal(readAnalyticsConsent(fake), 'unset');
});

test('disabled browser storage fails closed', () => {
  const broken = { getItem(){ throw Error('disabled'); }, setItem(){ throw Error('disabled'); } };
  assert.equal(readAnalyticsConsent(broken), 'unset');
  assert.doesNotThrow(() => saveAnalyticsConsent('declined', broken));
});


test('2.3 structured fields are optional but counted and validated', () => {
  const rich={...task, scope:'Mobile settings', outcome:'Dark theme usable', references:'https://example.com/figma'};
  assert.equal(reviewInputValid(rich),true);
  assert.equal(reviewTextLength(rich),reviewTextLength(task)+rich.scope.length+rich.outcome.length+rich.references.length);
  assert.equal(reviewInputValid({...task,scope:'x'.repeat(1001)}),false);
  assert.equal(reviewInputValid({...task,outcome:'x'.repeat(1001)}),false);
  assert.equal(reviewInputValid({...task,references:'x'.repeat(1001)}),false);
});

test('four control cases reproduce description-only task input',async()=>{
  const {readFile}=await import('node:fs/promises');
  const fixture=JSON.parse(await readFile(new URL('./fixtures/task-review-paste-only-v1.json',import.meta.url),'utf8'));
  assert.equal(fixture.cases.length,4);
  for(const {task,oracle} of fixture.cases) {
    assert.equal(task.title,'');
    assert.equal(task.type,'General');
    assert.equal(task.domain,'Other');
    for(const k of ['criteria','context','scope','outcome','references'])assert.equal(task[k],'');
    assert.ok(reviewInputValid(task));
    assert.ok(prepareReviewTask(task).title);
    for(const issue of oracle.must_detect)assert.ok(issue.source_quotes.every(q=>task.description.includes(q)));
  }
});
