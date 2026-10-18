import {createHmac, timingSafeEqual} from 'node:crypto';

export const WEBHOOK_EVENTS = new Set(['ping','issues','issue_comment','pull_request','pull_request_review','pull_request_review_comment','check_run','check_suite','status']);
export function verifyWebhook(secret: string, body: string | Buffer, signature: unknown): boolean {
  if (secret.length < 32 || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256',secret).update(body).digest(),Buffer.from(signature.slice(7),'hex'));
}
export function webhookSubject(event: string, body: any): {repository: string; issueNumber?: number; pullRequestNumber?: number} {
  if (!WEBHOOK_EVENTS.has(event)) throw new Error('Unsupported webhook event');
  const repository = body?.repository?.full_name;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid webhook repository');
  const positive = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
  const issueNumber = body?.issue?.pull_request ? undefined : positive(body?.issue?.number);
  const pullRequestNumber = positive(body?.pull_request?.number) ?? (body?.issue?.pull_request ? positive(body.issue.number) : undefined);
  return {repository:repository.toLowerCase(), ...(issueNumber ? {issueNumber}:{}), ...(pullRequestNumber ? {pullRequestNumber}:{})};
}
