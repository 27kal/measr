const XERO_ATTACHMENT_SCOPE = 'accounting.attachments';

export function hasXeroAttachmentScope(scopes: string[] | undefined): boolean {
  return scopes?.includes(XERO_ATTACHMENT_SCOPE) ?? false;
}

export function isXeroAttachmentPermissionError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /AuthorizationUnsuccessful|attachment (?:lookup|upload) failed \(401\)|\"Status\"\s*:\s*401/i.test(message);
}

export function xeroAttachmentErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  if (isXeroAttachmentPermissionError(message)) {
    return 'Xero needs attachment permission. Reconnect once and Workbench will retry this file automatically.';
  }
  return message;
}
