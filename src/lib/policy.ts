// Capability-policy hash. Emitted in every audit row and verified at startup.
// Placeholder — sec-10 replaces this with the SHA-256 of the canonicalized
// capability policy document. Until sec-10 lands, every audit row carries
// the literal string 'PENDING_SEC_10' so that the policy_hash column is never
// null and the cutover is a single-line edit.
export const POLICY_HASH = 'PENDING_SEC_10';
