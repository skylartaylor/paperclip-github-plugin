/** SDK-only sync never calls the board REST API. Unknown settings fail closed. */
export function requiresBoardAccess(required: boolean, settings?: {sdkOnlySync?: boolean} | null): boolean {
  return required && settings?.sdkOnlySync !== true;
}
