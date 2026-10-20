// #17230: a publish takes 1-4 h while the release branch gets several pushes an hour, so
// with cancel-in-progress every newer push killed the in-flight publish and :next never
// finished (13 days stale). A started publish must run to completion; GitHub keeps one
// running + one pending run per group, so a push storm still collapses to the newest SHA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

type Workflow = { concurrency: { group: string; "cancel-in-progress": unknown } };

const workflow = load(
  readFileSync(resolve(".github/workflows/docker-publish.yml"), "utf8")
) as Workflow;

test("#17230 a newer push never cancels an in-flight docker publish", () => {
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

test("#17230 publishes stay serialized per ref so a merge storm cannot fan out (#11976)", () => {
  assert.match(workflow.concurrency.group, /github\.ref/);
});
