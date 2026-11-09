import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessDevinCapability,
  fallbackForDevin,
  isMutationFreeProbeArgv,
  planDevinProbe,
} from "./devin.ts";

describe("planDevinProbe", () => {
  it("contains only read-only, mutation-free argv", () => {
    const plan = planDevinProbe();
    assert.ok(plan.length > 0);
    for (const argv of plan) {
      assert.equal(isMutationFreeProbeArgv(argv), true, argv.join(" "));
    }
  });

  it("never plans dispatch mutations", () => {
    const planText = planDevinProbe().map((argv) => argv.join(" ")).join("\n");
    assert.doesNotMatch(planText, /worker-start/);
    assert.doesNotMatch(planText, /dispatch/);
    assert.doesNotMatch(planText, /\bsend\b/);
  });

  it("flags known mutations as non-probe commands", () => {
    assert.equal(isMutationFreeProbeArgv(["orchestration", "worker-start"]), false);
    assert.equal(isMutationFreeProbeArgv(["terminal", "send"]), false);
    assert.equal(isMutationFreeProbeArgv(["worktree", "create"]), false);
  });
});

describe("assessDevinCapability", () => {
  it("requires a live smoke for verified; docs alone stay unknown", () => {
    const withoutSmoke = assessDevinCapability({
      binaryReachable: true,
      versionObserved: true,
      devinAccountPresent: true,
      supervisedVerbsPresent: true,
      guideMentionsDevinSupervised: true,
      liveSupervisedSmokeSucceeded: null,
    });
    assert.equal(withoutSmoke.status, "unknown");
    assert.equal(withoutSmoke.supervisedSupported, false);

    const verified = assessDevinCapability({
      binaryReachable: true,
      versionObserved: true,
      devinAccountPresent: true,
      supervisedVerbsPresent: true,
      guideMentionsDevinSupervised: true,
      liveSupervisedSmokeSucceeded: true,
    });
    assert.equal(verified.status, "verified");
    assert.equal(verified.supervisedSupported, true);
  });

  it("marks unsupported on positive negative evidence, with fallback", () => {
    const viaGuide = assessDevinCapability({
      binaryReachable: true,
      versionObserved: true,
      devinAccountPresent: false,
      supervisedVerbsPresent: null,
      guideMentionsDevinSupervised: false,
      liveSupervisedSmokeSucceeded: null,
    });
    assert.equal(viaGuide.status, "unsupported");
    assert.equal(viaGuide.supervisedSupported, false);
    assert.equal(viaGuide.terminalFallbackAllowed, true);

    const viaSchema = assessDevinCapability({
      binaryReachable: true,
      versionObserved: true,
      devinAccountPresent: false,
      supervisedVerbsPresent: false,
      guideMentionsDevinSupervised: null,
      liveSupervisedSmokeSucceeded: null,
    });
    assert.equal(viaSchema.status, "unsupported");
  });

  it("stays unknown on thin evidence and unavailable without a binary", () => {
    const thin = assessDevinCapability({
      binaryReachable: null,
      versionObserved: false,
      devinAccountPresent: null,
      supervisedVerbsPresent: null,
      guideMentionsDevinSupervised: null,
      liveSupervisedSmokeSucceeded: null,
    });
    assert.equal(thin.status, "unknown");
    assert.equal(thin.terminalFallbackAllowed, false);

    const unreachable = assessDevinCapability({
      binaryReachable: false,
      versionObserved: false,
      devinAccountPresent: null,
      supervisedVerbsPresent: null,
      guideMentionsDevinSupervised: null,
      liveSupervisedSmokeSucceeded: null,
    });
    assert.equal(unreachable.status, "unavailable");
    assert.equal(unreachable.terminalFallbackAllowed, false);
  });
});

describe("fallbackForDevin", () => {
  it("describes a flag-free controlled-terminal fallback for unsupported", () => {
    const fallback = fallbackForDevin({
      name: "devin",
      status: "unsupported",
      supervisedSupported: false,
      terminalFallbackAllowed: true,
      notes: "no supervised verbs",
    });
    assert.ok(fallback);
    assert.equal(fallback?.mode, "controlled-terminal");
    assert.equal(fallback?.supervised, false);
    // The fallback descriptor must carry no argv, flags, or commands.
    assert.ok(!("argv" in (fallback as object)));
    assert.ok(!("flags" in (fallback as object)));
    assert.ok(!("command" in (fallback as object)));
  });

  it("returns null for verified, unknown, unavailable, or other providers", () => {
    for (const status of ["verified", "unknown", "unavailable"] as const) {
      assert.equal(
        fallbackForDevin({
          name: "devin",
          status,
          supervisedSupported: status === "verified",
          terminalFallbackAllowed: true,
          notes: "n/a",
        }),
        null,
      );
    }
    assert.equal(
      fallbackForDevin({
        name: "muse",
        status: "unsupported",
        supervisedSupported: false,
        terminalFallbackAllowed: true,
        notes: "wrong lane",
      }),
      null,
    );
  });
});
