import type { CompanySetup, ReadinessCheck } from './types';

export function readinessChecks(setup: CompanySetup): ReadinessCheck[] {
  return [
    { id: 'xero', label: 'Connect Xero', complete: setup.xeroConnected, blocking: true },
    { id: 'bank', label: 'Bank accounts synced from Xero', complete: setup.bankSourceConnected, blocking: true },
    { id: 'currency', label: 'Confirm GBP base currency', complete: setup.baseCurrency === 'GBP', blocking: true },
    { id: 'vat_registration', label: 'Confirm VAT registration status', complete: setup.vatRegistered !== null, blocking: true },
    {
      id: 'vat_scheme',
      label: setup.vatRegistered === true ? 'Confirm VAT scheme' : setup.vatRegistered === false ? 'VAT scheme not required' : 'Confirm VAT scheme if applicable',
      complete: setup.vatRegistered === false || setup.vatScheme !== null,
      blocking: setup.vatRegistered === true
    }
  ];
}

export function isOperational(setup: CompanySetup): boolean {
  return readinessChecks(setup).every(check => !check.blocking || check.complete);
}
