/**
 * ForgeFleet deterministic policy engine (FF-004).
 *
 * Decides authorization for control-plane actions from
 * `docs/05-contracts/policy-matrix.md` and the approval classes in
 * `docs/03-architecture/security-and-trust.md`.
 *
 * Deterministic: the same input always yields the same verdict. No LLM,
 * no message text, and no connection state is consulted. In particular a
 * worker chat instruction is NEVER authority: only the authenticated
 * `actor` identity object passed to `authorize()` counts, and any claim
 * carried via message content (`context.claimedViaMessage`) is denied.
 *
 * verdicts: `allow` | `deny` | `require_owner`
 * - `allow`: perform the action (AUTO_SAFE / satisfied AUTO_CHECKED).
 * - `require_owner`: nobody except an authenticated owner action may
 *   perform it. Callers must open a durable owner decision (never a chat
 *   utterance) and re-invoke `authorize()` with `context.approval`.
 * - `deny`: must not be performed under the presented inputs.
 *
 * NOTE (E05 dependency): `packages/bridge-contracts` does not exist yet,
 * so the decision shape below is defined locally. Reconcile field names
 * with the E05 contract custodian before v0.1 integration.
 */

export const POLICY_VERSION = '0.1.0';

export const ROLES = Object.freeze([
  'owner',
  'coordinator',
  'lead',
  'worker',
  'reviewer',
  'service',
]);

export const APPROVAL_CLASSES = Object.freeze({
  AUTO_SAFE: 'AUTO_SAFE',
  AUTO_CHECKED: 'AUTO_CHECKED',
  OWNER_REQUIRED: 'OWNER_REQUIRED',
  DENY: 'DENY',
});

export const VERDICTS = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  REQUIRE_OWNER: 'require_owner',
});

/**
 * Action catalog. `roles` lists which roles may receive a non-deny
 * verdict for the action (before project scope and gate checks).
 * `requestOnly` means non-owner roles can only raise an owner decision,
 * never execute. `never` means denied for every role including owner.
 */
export const ACTION_CATALOG = Object.freeze({
  'task.read': { approvalClass: 'AUTO_SAFE', roles: ['owner', 'coordinator', 'lead', 'worker', 'reviewer', 'service'] },
  'context.read': { approvalClass: 'AUTO_SAFE', roles: ['owner', 'coordinator', 'lead', 'worker', 'reviewer', 'service'] },
  'message.post': { approvalClass: 'AUTO_SAFE', roles: ['owner', 'coordinator', 'lead', 'worker', 'reviewer', 'service'] },
  'subtask.propose': { approvalClass: 'AUTO_SAFE', roles: ['owner', 'coordinator', 'lead', 'worker'] },
  'dispatch.propose': { approvalClass: 'AUTO_SAFE', roles: ['owner', 'coordinator', 'lead', 'worker'] },
  'dispatch.execute': { approvalClass: 'AUTO_CHECKED', roles: ['service'] },
  'pr.open': { approvalClass: 'AUTO_SAFE', roles: ['owner', 'coordinator', 'lead', 'worker'] },
  'review.approve': { approvalClass: 'AUTO_CHECKED', roles: ['owner', 'coordinator', 'lead', 'worker', 'reviewer'] },
  'merge.develop': { approvalClass: 'AUTO_CHECKED', roles: ['owner', 'coordinator'] },
  'merge.main': { approvalClass: 'OWNER_REQUIRED', roles: ['owner', 'coordinator'], requestOnly: ['coordinator'] },
  'deploy.production': { approvalClass: 'OWNER_REQUIRED', roles: ['owner', 'coordinator', 'lead'], requestOnly: ['coordinator', 'lead'] },
  'budget.increase': { approvalClass: 'OWNER_REQUIRED', roles: ['owner', 'coordinator', 'lead'], requestOnly: ['coordinator', 'lead'] },
  'host.create': { approvalClass: 'OWNER_REQUIRED', roles: ['owner', 'coordinator', 'lead'], requestOnly: ['coordinator', 'lead'] },
  'secrets.rotate': { approvalClass: 'OWNER_REQUIRED', roles: ['owner', 'coordinator'], requestOnly: ['coordinator'] },
  'permissions.grant': { approvalClass: 'OWNER_REQUIRED', roles: ['owner', 'coordinator'], requestOnly: ['coordinator'] },
  'secrets.read-cross-project': { approvalClass: 'DENY', roles: [], never: true },
  'protection.bypass': { approvalClass: 'DENY', roles: [], never: true },
  'resource.destroy': { approvalClass: 'OWNER_REQUIRED', roles: ['owner'] },
});

/**
 * @typedef {object} Actor
 * @property {string} type - e.g. 'human' | 'agent' | 'service'
 * @property {string} id
 * @property {string} role - one of ROLES
 * @property {string[]} [projects] - project ids the actor is scoped to.
 *   The single-operator owner may omit this to span projects.
 * @property {string} [sessionProjectId] - project the current session was
 *   issued for; a mismatch with the resource project means a stolen or
 *   confused session scope and is denied.
 *
 * @typedef {object} Resource
 * @property {string} kind
 * @property {string} [id]
 * @property {string} [projectId]
 * @property {string} [headSha] - current observed head SHA
 * @property {string} [authorId] - for review targets: PR author
 * @property {string} [reviewerId] - reviewer who approved (for merges)
 * @property {boolean} [checksPass] - required CI checks green at headSha
 * @property {boolean} [confirmed] - explicit confirmation token present
 *   (required for resource.destroy even by the owner)
 *
 * @typedef {object} OwnerApproval - a durable, authenticated owner action
 *   (never a chat utterance).
 * @property {string} grantedBy - must be 'owner'
 * @property {string} authProof - opaque server-minted reference proving the
 *   owner authenticated at the integration boundary. The policy engine
 *   treats it as opaque and requires its presence; minting and verifying
 *   it is the boundary's job (E16/services), never the caller's.
 * @property {string} action - action this approval covers
 * @property {string} resourceId - immutable ID of the exact approved target
 * @property {string} [targetSha] - exact state hash the owner approved
 *   (required for SHA-pinned actions: merge.main, deploy.production)
 * @property {number} expiresAt - finite epoch ms; expired (or non-finite)
 *   approval grants nothing
 * @property {string} [origin] - approvals originating from 'message' or
 *   'sleep-expiry' are invalid
 *
 * @typedef {object} AuthorizeContext
 * @property {boolean} [claimedViaMessage] - authority asserted through
 *   agent chat / PR text / log content instead of authenticated identity
 * @property {boolean} [sleeping] - owner sleep mode: OWNER_REQUIRED stays
 *   queued, never auto-approved
 * @property {boolean} [ownerReauth] - owner re-authenticated this session
 *   (required for secrets.rotate / permissions.grant)
 * @property {OwnerApproval} [approval]
 * @property {number} [now] - finite epoch ms clock; non-finite values
 *   fall back to the trusted clock (Date.now())
 *
 * @typedef {object} Decision
 * @property {'allow'|'deny'|'require_owner'} verdict
 * @property {string} approvalClass
 * @property {string} action
 * @property {{type:string,id:string,role:string}} actor
 * @property {string} reasonCode - stable machine-readable code
 * @property {string} reason - human-readable denial/queue rationale
 * @property {{policyVersion:string}} audit
 */

function decision(verdict, approvalClass, action, actor, reasonCode, reason) {
  return {
    verdict,
    approvalClass,
    action,
    actor: { type: actor.type, id: actor.id, role: actor.role },
    reasonCode,
    reason,
    audit: { policyVersion: POLICY_VERSION },
  };
}

function deny(action, actor, approvalClass, reasonCode, reason) {
  return decision(VERDICTS.DENY, approvalClass, action, actor, reasonCode, reason);
}

function requireOwner(action, actor, approvalClass, reasonCode, reason) {
  return decision(VERDICTS.REQUIRE_OWNER, approvalClass, action, actor, reasonCode, reason);
}

/**
 * Actions whose approval must pin the exact current state hash on both
 * sides (approval and resource). Absent, stale, or mismatched values
 * reject: the decision reopens against the new state, it never passes.
 */
export const SHA_PINNED_ACTIONS = Object.freeze(['merge.main', 'deploy.production']);

/**
 * Validate a durable owner approval against the requested action state.
 * Fail-closed: every binding is required, never optional.
 * Returns null when valid, otherwise a reasonCode string.
 */
function ownerApprovalError(approval, action, resource, now) {
  if (!approval) return 'OWNER_APPROVAL_MISSING';
  if (approval.grantedBy !== 'owner') return 'OWNER_APPROVAL_NOT_OWNER';
  // An approval object alone proves nothing about identity. The server
  // integration boundary must mint `authProof` (opaque reference) only
  // after real owner authentication and never accept client-supplied
  // values. Without it the object is not an approval.
  if (typeof approval.authProof !== 'string' || approval.authProof.length === 0) {
    return 'OWNER_APPROVAL_UNAUTHENTICATED';
  }
  if (approval.action !== action) return 'OWNER_APPROVAL_ACTION_MISMATCH';
  if (approval.origin === 'message' || approval.origin === 'sleep-expiry') {
    return 'OWNER_APPROVAL_BAD_ORIGIN';
  }
  // Only finite epoch-ms values are time. NaN/Infinity are not timestamps:
  // `now >= NaN` is always false, so a typeof-only check lets NaN expiry
  // bypass and Infinity live forever. Fail closed as expired.
  if (!Number.isFinite(approval.expiresAt) || now >= approval.expiresAt) {
    return 'OWNER_APPROVAL_EXPIRED';
  }
  // Resource binding: both sides must carry a nonempty immutable ID.
  if (
    typeof resource.id !== 'string' || resource.id.length === 0 ||
    typeof approval.resourceId !== 'string' || approval.resourceId.length === 0
  ) {
    return 'OWNER_APPROVAL_TARGET_MISSING';
  }
  if (approval.resourceId !== resource.id) {
    return 'OWNER_APPROVAL_TARGET_MISMATCH';
  }
  // SHA binding for SHA-pinned actions: both sides must carry the exact
  // current state hash and agree on it.
  if (SHA_PINNED_ACTIONS.includes(action)) {
    if (
      typeof resource.headSha !== 'string' || resource.headSha.length === 0 ||
      typeof approval.targetSha !== 'string' || approval.targetSha.length === 0
    ) {
      return 'OWNER_APPROVAL_SHA_MISSING';
    }
    if (approval.targetSha !== resource.headSha) {
      return 'OWNER_APPROVAL_SHA_MISMATCH';
    }
  }
  return null;
}

/**
 * Map an approval validation failure to a verdict. Only a missing
 * approval queues an owner decision; every malformed, unauthenticated,
 * expired, or mismatched approval denies fail-closed.
 */
function approvalFailure(action, actor, approvalClass, reasonCode, context) {
  if (reasonCode === 'OWNER_APPROVAL_MISSING') {
    if (context.sleeping === true) {
      return requireOwner(action, actor, approvalClass, 'SLEEP_QUEUED',
        'Owner is sleeping: request is queued, never auto-approved.');
    }
    return requireOwner(action, actor, approvalClass, 'OWNER_REQUIRED',
      `Owner approval required for '${action}'.`);
  }
  const reasons = {
    OWNER_APPROVAL_NOT_OWNER: 'Approval was not granted by the owner.',
    OWNER_APPROVAL_UNAUTHENTICATED: 'Approval carries no server-minted authentication proof; the object alone proves nothing.',
    OWNER_APPROVAL_ACTION_MISMATCH: 'Approval covers a different action and does not transfer.',
    OWNER_APPROVAL_BAD_ORIGIN: 'Approval originates from message content or sleep expiry and is invalid.',
    OWNER_APPROVAL_EXPIRED: 'The owner approval has expired; expiry never grants authority.',
    OWNER_APPROVAL_TARGET_MISSING: 'Approval or resource lacks the required immutable resource ID binding.',
    OWNER_APPROVAL_TARGET_MISMATCH: 'The target changed after approval; the decision must be reopened against the new state.',
    OWNER_APPROVAL_SHA_MISSING: 'Approval or resource lacks the required exact state-hash binding.',
    OWNER_APPROVAL_SHA_MISMATCH: 'The target changed after approval; the decision must be reopened against the new state.',
  };
  return deny(action, actor, approvalClass, reasonCode, reasons[reasonCode] ?? 'Approval invalid.');
}

/**
 * Authorize one control-plane action. Pure function: no I/O, no clock
 * except `context.now`.
 *
 * @param {{actor: Actor, action: string, resource?: Resource, context?: AuthorizeContext}} input
 * @returns {Decision}
 */
export function authorize(input) {
  const { actor, action } = input;
  const resource = input.resource ?? {};
  const context = input.context ?? {};
  // Trusted clock: only a finite caller-supplied `now` is usable as time.
  // NaN/Infinity/non-numbers fall back to Date.now(), never to
  // attacker-controlled time (`now >= expiresAt` is false for NaN now,
  // which would otherwise resurrect expired approvals).
  const now = Number.isFinite(context.now) ? context.now : Date.now();

  // 0. Message content is never authority.
  if (context.claimedViaMessage === true) {
    return deny(action, actor, 'DENY', 'MESSAGE_NOT_AUTHORITY',
      'Authority asserted via message content; only the authenticated actor identity counts.');
  }

  // 1. Closed world: unknown action or role denies.
  const spec = ACTION_CATALOG[action];
  if (!spec) {
    return deny(action, actor, 'DENY', 'UNKNOWN_ACTION',
      `Unknown action '${action}'; closed-world deny.`);
  }
  if (!ROLES.includes(actor.role)) {
    return deny(action, actor, spec.approvalClass, 'UNKNOWN_ROLE',
      `Unknown role '${actor.role}'; closed-world deny.`);
  }

  // 2. DENY class: never permitted, for any role including owner.
  if (spec.never === true) {
    return deny(action, actor, spec.approvalClass, 'ALWAYS_DENY',
      `Action '${action}' is DENY-class and can never be authorized.`);
  }

  // 3. Project isolation. Owner spans projects (single operator);
  // everyone else must be scoped to the resource project.
  if (resource.projectId !== undefined && actor.role !== 'owner') {
    const projects = Array.isArray(actor.projects) ? actor.projects : [];
    if (!projects.includes(resource.projectId)) {
      return deny(action, actor, spec.approvalClass, 'CROSS_PROJECT_DENIED',
        `Role '${actor.role}' is not scoped to project '${resource.projectId}'.`);
    }
  }

  // 4. Stolen/confused session scope.
  if (
    actor.sessionProjectId !== undefined &&
    resource.projectId !== undefined &&
    actor.sessionProjectId !== resource.projectId
  ) {
    return deny(action, actor, spec.approvalClass, 'SESSION_SCOPE_MISMATCH',
      'Session was issued for a different project than the target resource.');
  }

  // 5. Role membership. A role outside the catalog entry can neither
  // execute nor request the action (a worker asking the owner is a
  // message.post, not the privileged action itself). Request-only access
  // is expressed explicitly via `requestOnly`, never inferred.
  if (!spec.roles.includes(actor.role)) {
    return deny(action, actor, spec.approvalClass, 'ROLE_NOT_PERMITTED',
      `Role '${actor.role}' may not perform '${action}'.`);
  }

  // 6. Request-only roles queue an owner decision; sleep never approves.
  if (Array.isArray(spec.requestOnly) && spec.requestOnly.includes(actor.role)) {
    if (context.sleeping === true) {
      return requireOwner(action, actor, spec.approvalClass, 'SLEEP_QUEUED',
        'Owner is sleeping: request is queued, never auto-approved.');
    }
    return requireOwner(action, actor, spec.approvalClass, 'OWNER_REQUIRED',
      `Role '${actor.role}' may only request owner approval for '${action}'.`);
  }

  // 7. Action-specific gates for executing roles.
  switch (action) {
    case 'review.approve': {
      if (resource.authorId !== undefined && resource.authorId === actor.id) {
        return deny(action, actor, spec.approvalClass, 'SELF_APPROVAL',
          'Self-approval is forbidden; an independent reviewer is required.');
      }
      break;
    }
    case 'merge.develop': {
      // Checks are only meaningful bound to an exact head SHA. The
      // integration boundary (E16) must source `checksPass` from trusted
      // GitHub check/webhook state at that SHA; policy rejects unbound
      // inputs rather than assuming provenance.
      if (typeof resource.headSha !== 'string' || resource.headSha.length === 0) {
        return deny(action, actor, spec.approvalClass, 'CHECKS_SHA_MISSING',
          'Merge requires check results bound to an exact PR head SHA.');
      }
      if (resource.checksPass !== true) {
        return deny(action, actor, spec.approvalClass, 'CHECKS_NOT_PASSING',
          'Required checks are not green at the current head SHA.');
      }
      // An independent reviewer is a non-empty identity distinct from the
      // author. An empty reviewerId is no review at all and must not pass.
      if (typeof resource.reviewerId !== 'string' || resource.reviewerId.length === 0 ||
          resource.reviewerId === resource.authorId) {
        return deny(action, actor, spec.approvalClass, 'REVIEW_NOT_INDEPENDENT',
          'Merge into develop requires an independent reviewer (not the author).');
      }
      break;
    }
    case 'merge.main':
    case 'deploy.production':
    case 'budget.increase':
    case 'host.create': {
      // Owner-only execution with a fresh, fully-bound approval
      // (identity proof, resource ID, and state hash where pinned).
      const err = ownerApprovalError(context.approval, action, resource, now);
      if (err !== null) {
        return approvalFailure(action, actor, spec.approvalClass, err, context);
      }
      break;
    }
    case 'secrets.rotate':
    case 'permissions.grant': {
      if (context.ownerReauth !== true) {
        return requireOwner(action, actor, spec.approvalClass, 'OWNER_REAUTH_REQUIRED',
          'Owner session re-authentication is required before granting permissions or rotating secrets.');
      }
      const err = ownerApprovalError(context.approval, action, resource, now);
      if (err !== null) {
        return approvalFailure(action, actor, spec.approvalClass, err, context);
      }
      break;
    }
    case 'resource.destroy': {
      if (resource.confirmed !== true) {
        return deny(action, actor, spec.approvalClass, 'CONFIRMATION_REQUIRED',
          'Destruction requires an explicit resource confirmation, even from the owner.');
      }
      const err = ownerApprovalError(context.approval, action, resource, now);
      if (err !== null) {
        return approvalFailure(action, actor, spec.approvalClass, err, context);
      }
      break;
    }
    default:
      break;
  }

  return decision(VERDICTS.ALLOW, spec.approvalClass, action, actor, 'OK',
    `Role '${actor.role}' is authorized for '${action}'.`);
}

/**
 * List the actions a role may receive a non-deny verdict for.
 * Introspection helper for audits and UI permission display.
 */
export function allowedActionsFor(role) {
  return Object.entries(ACTION_CATALOG)
    .filter(([, spec]) => spec.roles.includes(role))
    .map(([action]) => action);
}
