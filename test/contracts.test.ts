import assert from "node:assert/strict";
import test from "node:test";
import { validateObjectTypeDef } from "@godmode/kernel";
import {
  githubRepositoryObjectType,
  pullRequestObjectType,
} from "../src/adapters.js";

test("GitHub ObjectType contracts pass kernel validation", () => {
  assert.deepEqual(validateObjectTypeDef(githubRepositoryObjectType), []);
  assert.deepEqual(validateObjectTypeDef(pullRequestObjectType), []);
});

test("every mutation action declares a strict executable contract", () => {
  const actions = [
    ...(githubRepositoryObjectType.actions ?? []),
    ...(pullRequestObjectType.actions ?? []),
  ];
  assert.equal(actions.length, 4);
  for (const action of actions) {
    assert.equal(action.target, "record");
    assert.ok(["external", "destructive"].includes(action.effect ?? ""));
    assert.equal(action.execution, "sync");
    assert.ok(action.roles?.length);
    assert.equal(action.confirmation?.required, true);
    assert.equal(action.idempotency?.required, true);
    assert.ok(action.timeoutMs && action.timeoutMs > 0);
    assert.ok(action.inputSchema);
    assert.ok(action.outputSchema);
    assert.ok(action.errorSchema);
    assert.ok(action.events?.length);
  }
});

test("merge is destructive and restricted to privileged roles", () => {
  const merge = pullRequestObjectType.actions?.find(
    (action) => action.name === "merge"
  );
  assert.equal(merge?.effect, "destructive");
  assert.deepEqual(merge?.roles, ["owner", "intelligence"]);
  assert.equal(merge?.confirmation?.required, true);
});
