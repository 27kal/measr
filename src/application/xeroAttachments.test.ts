import { describe, expect, it } from 'vitest';
import { hasXeroAttachmentScope, isXeroAttachmentPermissionError, xeroAttachmentErrorMessage } from './xeroAttachments';

describe('Xero attachment permissions', () => {
  it('detects the attachment OAuth scope', () => {
    expect(hasXeroAttachmentScope(['offline_access', 'accounting.attachments'])).toBe(true);
    expect(hasXeroAttachmentScope(['accounting.banktransactions'])).toBe(false);
  });

  it('translates Xero attachment authorization failures into an actionable message', () => {
    const error = 'Xero attachment lookup failed (401): {"Status":401,"Detail":"AuthorizationUnsuccessful"}';
    expect(isXeroAttachmentPermissionError(error)).toBe(true);
    expect(xeroAttachmentErrorMessage(error)).toBe('Xero needs attachment permission. Reconnect once and Workbench will retry this file automatically.');
  });

  it('preserves unrelated attachment failures for retry and diagnosis', () => {
    const error = 'Xero attachment upload failed (503): temporarily unavailable';
    expect(isXeroAttachmentPermissionError(error)).toBe(false);
    expect(xeroAttachmentErrorMessage(error)).toBe(error);
  });
});
