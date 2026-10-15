export const RIXFLOW_VERSION = '1.1.0';

// The oldest RixFlow that reads the workflow.yml format setup writes (its `requires:`). Bump it only
// when the format changes, so a patch release never locks out teammates who have not updated yet.
export const WORKFLOW_REQUIRES = '0.3.0';
