#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '../..');
const envPath = resolve(rootDir, '.env.local');
const stateDir = resolve(rootDir, '.xero-spike');
const tokenPath = resolve(stateDir, 'token.json');
const rawDir = resolve(stateDir, 'raw');
const manifestPath = resolve(stateDir, 'manifest.json');
const importDir = resolve(stateDir, 'import');

const oauth = {
  authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
  tokenUrl: 'https://identity.xero.com/connect/token',
  connectionsUrl: 'https://api.xero.com/connections',
  accountingBaseUrl: 'https://api.xero.com/api.xro/2.0'
};

const scopes = [
  'offline_access',
  'accounting.settings.read',
  'accounting.contacts.read',
  'accounting.invoices',
  'accounting.payments',
  'accounting.banktransactions'
];

function parseEnv(text) {
  const values = {};
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadConfig({ requireCredentials = true } = {}) {
  let fileValues = {};
  try {
    fileValues = parseEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const config = {
    clientId: process.env.XERO_CLIENT_ID || fileValues.XERO_CLIENT_ID || '',
    clientSecret: process.env.XERO_CLIENT_SECRET || fileValues.XERO_CLIENT_SECRET || '',
    redirectUri: process.env.XERO_REDIRECT_URI || fileValues.XERO_REDIRECT_URI || 'http://localhost:8766/oauth/callback'
  };

  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== 'http:' || redirect.hostname !== 'localhost' || redirect.pathname !== '/oauth/callback') {
    throw new Error('XERO_REDIRECT_URI must be exactly an http://localhost URL ending in /oauth/callback for this local experiment.');
  }

  if (requireCredentials && (!config.clientId || !config.clientSecret)) {
    throw new Error(`Add XERO_CLIENT_ID and XERO_CLIENT_SECRET to ${envPath}. Do not paste the secret into chat.`);
  }
  return config;
}

function basicAuth(config) {
  return Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
}

async function requestToken(config, parameters) {
  const response = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(config)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(parameters)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new Error(`Xero token request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function saveToken(token) {
  await mkdir(stateDir, { recursive: true });
  const stored = {
    ...token,
    obtained_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + Number(token.expires_in || 1800) * 1000).toISOString()
  };
  await writeFile(tokenPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return stored;
}

async function readToken() {
  try {
    return JSON.parse(await readFile(tokenPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No OAuth token exists yet. Run the serve command and connect the demo company.');
    throw error;
  }
}

async function usableToken(config) {
  let token = await readToken();
  const expiresAt = Date.parse(token.expires_at || 0);
  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) return token;
  if (!token.refresh_token) throw new Error('The stored token is expired and has no refresh token. Reconnect the demo company.');
  token = await requestToken(config, { grant_type: 'refresh_token', refresh_token: token.refresh_token });
  return saveToken(token);
}

async function xeroRequest(config, url, { tenantId, method = 'GET', body, extraHeaders = {} } = {}) {
  const token = await usableToken(config);
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    Accept: 'application/json',
    ...extraHeaders
  };
  if (tenantId) headers['xero-tenant-id'] = tenantId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!response.ok) {
    throw new Error(`Xero API request failed (${response.status} ${method} ${url}): ${JSON.stringify(parsed)}`);
  }
  return {
    body: parsed,
    status: response.status,
    responseHeaders: {
      minLimitRemaining: response.headers.get('x-minlimit-remaining'),
      dayLimitRemaining: response.headers.get('x-daylimit-remaining'),
      appMinLimitRemaining: response.headers.get('x-appminlimit-remaining')
    }
  };
}

async function xeroFetch(config, url, options = {}) {
  return (await xeroRequest(config, url, options)).body;
}

async function getConnections(config) {
  return xeroFetch(config, oauth.connectionsUrl);
}

function selectedConnection(connections) {
  if (connections.length === 0) throw new Error('The app has no connected Xero tenant.');
  const requestedTenant = process.env.XERO_TENANT_ID || '';
  if (requestedTenant) {
    const match = connections.find(connection => connection.tenantId === requestedTenant);
    if (!match) throw new Error('XERO_TENANT_ID does not match any connected tenant.');
    return match;
  }
  if (connections.length > 1) {
    throw new Error('More than one tenant is connected. Set XERO_TENANT_ID locally before running mutation experiments.');
  }
  return connections[0];
}

async function accountingGet(config, tenantId, resource) {
  return xeroFetch(config, `${oauth.accountingBaseUrl}/${resource}`, { tenantId });
}

async function accountingMutate(config, tenantId, resource, method, body, idempotencyKey) {
  return xeroRequest(config, `${oauth.accountingBaseUrl}/${resource}`, {
    tenantId,
    method,
    body,
    extraHeaders: { 'Idempotency-Key': idempotencyKey }
  });
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function savePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function saveManifest(manifest) {
  manifest.updatedAt = new Date().toISOString();
  await savePrivateJson(manifestPath, manifest);
}

function isoDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function objectMarker(root, role) {
  return `${root}-${role}`;
}

function sourceUrl(marker) {
  return `https://example.com/workbench/lines/${encodeURIComponent(marker)}`;
}

function validationErrors(body) {
  const candidates = [
    ...(body?.BankTransactions || []),
    ...(body?.Invoices || []),
    ...(body?.BankTransfers || []),
    ...(body?.HistoryRecords || [])
  ];
  return candidates.flatMap(candidate => candidate.ValidationErrors || []).map(error => error.Message);
}

async function persistMutation(manifest, role, request, result) {
  const capturePath = resolve(rawDir, `${manifest.rootMarker}-${role.toLowerCase()}.json`);
  await savePrivateJson(capturePath, { request, response: result });
  Object.assign(manifest.objects[role], {
    request,
    responseCapture: capturePath,
    completedAt: new Date().toISOString()
  });
  await saveManifest(manifest);
}

async function addHistoryNote(config, tenantId, endpoint, objectId, marker) {
  const request = {
    resource: `${endpoint}/${objectId}/History`,
    method: 'PUT',
    body: { HistoryRecords: [{ Details: `Prepared by Workbench capability experiment · ${marker}` }] },
    idempotencyKey: `${randomUUID()}${randomUUID()}`
  };
  const result = await accountingMutate(config, tenantId, request.resource, request.method, request.body, request.idempotencyKey);
  return { request, result };
}

async function commandCheck() {
  const config = await loadConfig({ requireCredentials: false });
  console.log(JSON.stringify({
    envFile: envPath,
    clientIdConfigured: Boolean(config.clientId),
    clientSecretConfigured: Boolean(config.clientSecret),
    redirectUri: config.redirectUri,
    tokenFileExists: await readFile(tokenPath, 'utf8').then(() => true, () => false),
    scopes
  }, null, 2));
}

async function commandConnections() {
  const config = await loadConfig();
  const connections = await getConnections(config);
  console.log(JSON.stringify(connections.map(connection => ({
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    tenantType: connection.tenantType,
    createdDateUtc: connection.createdDateUtc,
    updatedDateUtc: connection.updatedDateUtc
  })), null, 2));
}

async function commandBaseline() {
  const config = await loadConfig();
  const connections = await getConnections(config);
  const connection = selectedConnection(connections);
  const [organisations, accounts, contacts] = await Promise.all([
    accountingGet(config, connection.tenantId, 'Organisation'),
    accountingGet(config, connection.tenantId, 'Accounts'),
    accountingGet(config, connection.tenantId, 'Contacts?page=1&includeArchived=false')
  ]);

  await mkdir(rawDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const outputPath = resolve(rawDir, `${stamp}-baseline.json`);
  await writeFile(outputPath, `${JSON.stringify({ connection, organisations, accounts, contacts }, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);

  const organisation = organisations?.Organisations?.[0] || {};
  const accountList = accounts?.Accounts || [];
  const contactList = contacts?.Contacts || [];
  console.log(JSON.stringify({
    tenantName: connection.tenantName,
    organisationName: organisation.Name,
    countryCode: organisation.CountryCode,
    baseCurrency: organisation.BaseCurrency,
    organisationType: organisation.OrganisationType,
    bankAccounts: accountList.filter(account => account.Type === 'BANK').map(account => ({
      accountId: account.AccountID,
      code: account.Code,
      name: account.Name,
      currencyCode: account.CurrencyCode,
      status: account.Status
    })),
    activeExpenseAccounts: accountList.filter(account => account.Status === 'ACTIVE' && ['EXPENSE', 'DIRECTCOSTS', 'OVERHEADS'].includes(account.Type)).slice(0, 12).map(account => ({ code: account.Code, name: account.Name, type: account.Type })),
    contactSample: contactList.slice(0, 12).map(contact => ({ contactId: contact.ContactID, name: contact.Name, status: contact.ContactStatus })),
    rawCapture: outputPath
  }, null, 2));
}

async function commandPrepare() {
  const config = await loadConfig();
  const connections = await getConnections(config);
  const connection = selectedConnection(connections);
  let manifest = await readManifest();
  if (manifest?.objects && Object.values(manifest.objects).some(object => object.completedAt)) {
    throw new Error(`A fixture manifest already exists at ${manifestPath}. Run observe or cleanup rather than creating duplicate accounting objects.`);
  }

  const [accountResponse, contactResponse] = await Promise.all([
    accountingGet(config, connection.tenantId, 'Accounts'),
    accountingGet(config, connection.tenantId, 'Contacts?page=1&includeArchived=false')
  ]);
  const accountList = accountResponse?.Accounts || [];
  const contactList = (contactResponse?.Contacts || []).filter(contact => contact.ContactStatus === 'ACTIVE');
  const accountByCode = code => accountList.find(account => account.Code === code && account.Status === 'ACTIVE');
  const currentBank = accountByCode('090');
  const savingsBank = accountByCode('091');
  const consulting = accountByCode('412');
  const sales = accountByCode('200');
  const supplier = contactList[1] || contactList[0];
  const customer = contactList[2] || contactList[0];
  if (!currentBank || !savingsBank || !consulting || !sales || !supplier || !customer) {
    throw new Error('The demo organisation does not contain the expected bank, consulting, sales and contact fixtures. Review the baseline before proceeding.');
  }

  const rootMarker = manifest?.rootMarker || `WB-XSP-${isoDate().replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
  manifest ||= {
    schemaVersion: 1,
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    rootMarker,
    createdAt: new Date().toISOString(),
    date: isoDate(),
    dueDate: isoDate(14),
    fixture: {
      currentBank: { accountId: currentBank.AccountID, code: currentBank.Code, name: currentBank.Name },
      savingsBank: { accountId: savingsBank.AccountID, code: savingsBank.Code, name: savingsBank.Name },
      consulting: { accountId: consulting.AccountID, code: consulting.Code, name: consulting.Name, taxType: consulting.TaxType },
      sales: { accountId: sales.AccountID, code: sales.Code, name: sales.Name, taxType: sales.TaxType },
      supplier: { contactId: supplier.ContactID, name: supplier.Name },
      customer: { contactId: customer.ContactID, name: customer.Name }
    },
    objects: {}
  };

  const definitions = {
    spend: {
      marker: objectMarker(rootMarker, 'SPEND'),
      resource: 'BankTransactions?summarizeErrors=false',
      method: 'PUT',
      responseCollection: 'BankTransactions',
      idField: 'BankTransactionID',
      historyEndpoint: 'BankTransactions',
      body: {
        BankTransactions: [{
          Type: 'SPEND',
          Contact: { ContactID: supplier.ContactID },
          BankAccount: { AccountID: currentBank.AccountID },
          Date: isoDate(),
          Reference: objectMarker(rootMarker, 'SPEND'),
          Url: sourceUrl(objectMarker(rootMarker, 'SPEND')),
          LineAmountTypes: 'Inclusive',
          LineItems: [{ Description: `Workbench capability experiment · ${objectMarker(rootMarker, 'SPEND')}`, Quantity: 1, UnitAmount: 123.45, AccountCode: consulting.Code, TaxType: consulting.TaxType }],
          Status: 'AUTHORISED'
        }]
      }
    },
    receive: {
      marker: objectMarker(rootMarker, 'RECEIVE'),
      resource: 'BankTransactions?summarizeErrors=false',
      method: 'PUT',
      responseCollection: 'BankTransactions',
      idField: 'BankTransactionID',
      historyEndpoint: 'BankTransactions',
      body: {
        BankTransactions: [{
          Type: 'RECEIVE',
          Contact: { ContactID: customer.ContactID },
          BankAccount: { AccountID: currentBank.AccountID },
          Date: isoDate(),
          Reference: objectMarker(rootMarker, 'RECEIVE'),
          Url: sourceUrl(objectMarker(rootMarker, 'RECEIVE')),
          LineAmountTypes: 'Inclusive',
          LineItems: [{ Description: `Workbench capability experiment · ${objectMarker(rootMarker, 'RECEIVE')}`, Quantity: 1, UnitAmount: 234.56, AccountCode: sales.Code, TaxType: sales.TaxType }],
          Status: 'AUTHORISED'
        }]
      }
    },
    bill: {
      marker: objectMarker(rootMarker, 'BILL'),
      resource: 'Invoices?summarizeErrors=false',
      method: 'PUT',
      responseCollection: 'Invoices',
      idField: 'InvoiceID',
      historyEndpoint: 'Invoices',
      body: {
        Invoices: [{
          Type: 'ACCPAY',
          Contact: { ContactID: supplier.ContactID },
          Date: isoDate(),
          DueDate: isoDate(14),
          Reference: objectMarker(rootMarker, 'BILL'),
          Url: sourceUrl(objectMarker(rootMarker, 'BILL')),
          LineAmountTypes: 'Inclusive',
          LineItems: [{ Description: `Workbench capability experiment · ${objectMarker(rootMarker, 'BILL')}`, Quantity: 1, UnitAmount: 345.67, AccountCode: consulting.Code, TaxType: consulting.TaxType }],
          Status: 'AUTHORISED'
        }]
      }
    },
    invoice: {
      marker: objectMarker(rootMarker, 'INVOICE'),
      resource: 'Invoices?summarizeErrors=false',
      method: 'PUT',
      responseCollection: 'Invoices',
      idField: 'InvoiceID',
      historyEndpoint: 'Invoices',
      body: {
        Invoices: [{
          Type: 'ACCREC',
          Contact: { ContactID: customer.ContactID },
          Date: isoDate(),
          DueDate: isoDate(14),
          Reference: objectMarker(rootMarker, 'INVOICE'),
          Url: sourceUrl(objectMarker(rootMarker, 'INVOICE')),
          LineAmountTypes: 'Inclusive',
          LineItems: [{ Description: `Workbench capability experiment · ${objectMarker(rootMarker, 'INVOICE')}`, Quantity: 1, UnitAmount: 456.78, AccountCode: sales.Code, TaxType: sales.TaxType }],
          Status: 'AUTHORISED'
        }]
      }
    },
    transfer: {
      marker: objectMarker(rootMarker, 'TRANSFER'),
      resource: 'BankTransfers',
      method: 'PUT',
      responseCollection: 'BankTransfers',
      idField: 'BankTransferID',
      historyEndpoint: 'BankTransactions',
      body: {
        BankTransfers: [{
          FromBankAccount: { AccountID: currentBank.AccountID },
          ToBankAccount: { AccountID: savingsBank.AccountID },
          Amount: 67.89,
          Date: isoDate(),
          Reference: objectMarker(rootMarker, 'TRANSFER')
        }]
      }
    }
  };

  for (const [role, definition] of Object.entries(definitions)) {
    manifest.objects[role] ||= {
      marker: definition.marker,
      idempotencyKey: `${randomUUID()}${randomUUID()}`
    };
  }
  await saveManifest(manifest);

  for (const [role, definition] of Object.entries(definitions)) {
    const objectState = manifest.objects[role];
    if (objectState.completedAt) continue;
    const request = {
      resource: definition.resource,
      method: definition.method,
      body: definition.body,
      idempotencyKey: objectState.idempotencyKey
    };
    const result = await accountingMutate(config, connection.tenantId, request.resource, request.method, request.body, request.idempotencyKey);
    const errors = validationErrors(result.body);
    if (errors.length) throw new Error(`${role} failed validation: ${errors.join('; ')}`);
    const created = result.body?.[definition.responseCollection]?.[0];
    const objectId = created?.[definition.idField];
    if (!created || !objectId) throw new Error(`${role} response did not include ${definition.idField}.`);
    objectState.objectId = objectId;
    objectState.objectType = definition.responseCollection;
    objectState.returnedStatus = created.Status;
    objectState.total = created.Total ?? created.Amount;
    objectState.reference = created.Reference;
    objectState.url = created.Url ?? null;
    if (role === 'transfer') {
      objectState.fromBankTransactionId = created.FromBankTransactionID;
      objectState.toBankTransactionId = created.ToBankTransactionID;
    }
    await persistMutation(manifest, role, request, result);

    const historyObjectId = role === 'transfer' ? objectState.fromBankTransactionId : objectId;
    if (historyObjectId) {
      const history = await addHistoryNote(config, connection.tenantId, definition.historyEndpoint, historyObjectId, definition.marker);
      const noteErrors = validationErrors(history.result.body);
      objectState.historyNote = {
        endpoint: `${definition.historyEndpoint}/${historyObjectId}/History`,
        written: noteErrors.length === 0,
        errors: noteErrors,
        responseCapture: resolve(rawDir, `${manifest.rootMarker}-${role}-history.json`)
      };
      await savePrivateJson(objectState.historyNote.responseCapture, history);
      await saveManifest(manifest);
    }
  }

  await writeImportFixtures(manifest);
  console.log(JSON.stringify(manifestSummary(manifest), null, 2));
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeImportFixtures(manifest) {
  await mkdir(importDir, { recursive: true });
  const headers = ['Date', 'Amount', 'Payee', 'Description', 'Reference'];
  const date = manifest.date.split('-').reverse().join('/');
  const currentRows = [
    [date, '-123.45', manifest.fixture.supplier.name, 'Workbench spend-money match', manifest.objects.spend.marker],
    [date, '234.56', manifest.fixture.customer.name, 'Workbench receive-money match', manifest.objects.receive.marker],
    [date, '-345.67', manifest.fixture.supplier.name, 'Workbench authorised-bill payment', manifest.objects.bill.marker],
    [date, '456.78', manifest.fixture.customer.name, 'Workbench authorised-invoice payment', manifest.objects.invoice.marker],
    [date, '-67.89', 'Transfer to Business Savings Account', 'Workbench transfer source', manifest.objects.transfer.marker]
  ];
  const savingsRows = [
    [date, '67.89', 'Transfer from Business Bank Account', 'Workbench transfer destination', manifest.objects.transfer.marker]
  ];
  const render = rows => `${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n')}\n`;
  const currentPath = resolve(importDir, `${manifest.rootMarker}-090.csv`);
  const savingsPath = resolve(importDir, `${manifest.rootMarker}-091.csv`);
  await writeFile(currentPath, render(currentRows), { mode: 0o600 });
  await writeFile(savingsPath, render(savingsRows), { mode: 0o600 });
  await chmod(currentPath, 0o600);
  await chmod(savingsPath, 0o600);
  manifest.importFiles = { current: currentPath, savings: savingsPath };
  await saveManifest(manifest);
}

function manifestSummary(manifest) {
  return {
    tenantName: manifest.tenantName,
    rootMarker: manifest.rootMarker,
    date: manifest.date,
    objects: Object.fromEntries(Object.entries(manifest.objects).map(([role, object]) => [role, {
      marker: object.marker,
      objectType: object.objectType,
      objectId: object.objectId,
      returnedStatus: object.returnedStatus,
      total: object.total,
      reference: object.reference,
      urlStored: Boolean(object.url),
      historyNoteWritten: object.historyNote?.written ?? false,
      fromBankTransactionId: object.fromBankTransactionId,
      toBankTransactionId: object.toBankTransactionId
    }])),
    importFiles: manifest.importFiles,
    manifestPath
  };
}

async function commandObserve() {
  const config = await loadConfig();
  const manifest = await readManifest();
  if (!manifest) throw new Error('No fixture manifest exists. Run prepare first.');
  const observations = {};
  for (const [role, object] of Object.entries(manifest.objects)) {
    if (!object.objectId) continue;
    const resource = role === 'transfer' ? `BankTransfers/${object.objectId}` : object.objectType === 'Invoices' ? `Invoices/${object.objectId}` : `BankTransactions/${object.objectId}`;
    const historyResource = role === 'transfer' ? `BankTransactions/${object.fromBankTransactionId}/History` : `${object.objectType}/${object.objectId}/History`;
    const [entity, history] = await Promise.all([
      accountingGet(config, manifest.tenantId, resource),
      accountingGet(config, manifest.tenantId, historyResource)
    ]);
    const collection = role === 'transfer' ? entity?.BankTransfers : object.objectType === 'Invoices' ? entity?.Invoices : entity?.BankTransactions;
    const record = collection?.[0] || {};
    const historyItems = history?.HistoryRecords || [];
    const currentPaymentIds = (record.Payments || []).map(payment => payment.PaymentID).filter(Boolean);
    object.observedPaymentIds = [...new Set([...(object.observedPaymentIds || []), ...currentPaymentIds])];
    const paymentDetails = object.objectType === 'Invoices'
      ? await Promise.all(object.observedPaymentIds.map(async paymentId => {
          try {
            const paymentResponse = await accountingGet(config, manifest.tenantId, `Payments/${paymentId}`);
            const payment = paymentResponse?.Payments?.[0] || {};
            return {
              paymentId,
              status: payment.Status,
              amount: payment.Amount,
              date: payment.Date,
              isReconciled: payment.IsReconciled,
              bankAccountId: payment.Account?.AccountID,
              invoiceId: payment.Invoice?.InvoiceID,
              updatedDateUtc: payment.UpdatedDateUTC
            };
          } catch (error) {
            return { paymentId, observationError: error.message };
          }
        }))
      : [];
    const markerNote = historyItems.find(item => String(item.Details || '').includes(object.marker));
    object.historyNote = {
      ...(object.historyNote || {}),
      endpoint: historyResource,
      written: Boolean(markerNote),
      observedAt: new Date().toISOString()
    };
    observations[role] = {
      observedAt: new Date().toISOString(),
      objectId: object.objectId,
      status: record.Status,
      type: record.Type,
      total: record.Total ?? record.Amount,
      amountDue: record.AmountDue,
      amountPaid: record.AmountPaid,
      isReconciled: record.IsReconciled,
      fromIsReconciled: record.FromIsReconciled,
      toIsReconciled: record.ToIsReconciled,
      reference: record.Reference,
      url: record.Url,
      payments: paymentDetails.length
        ? paymentDetails
        : (record.Payments || []).map(payment => ({ paymentId: payment.PaymentID, amount: payment.Amount, date: payment.Date, isReconciled: payment.IsReconciled })),
      history: historyItems.map(item => ({ changes: item.Changes, user: item.User, details: item.Details, dateUtc: item.DateUTCString || item.DateUTC }))
    };
  }
  await saveManifest(manifest);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const capturePath = resolve(rawDir, `${stamp}-${manifest.rootMarker}-observation.json`);
  await savePrivateJson(capturePath, observations);
  console.log(JSON.stringify({ rootMarker: manifest.rootMarker, observations, rawCapture: capturePath }, null, 2));
}

async function commandServe() {
  const config = await loadConfig();
  const redirect = new URL(config.redirectUri);
  const csrfState = randomBytes(24).toString('base64url');
  const authorizationUrl = new URL(oauth.authorizeUrl);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: scopes.join(' '),
    state: csrfState
  }).toString();

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', config.redirectUri);
      if (requestUrl.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(`<!doctype html><meta charset="utf-8"><title>Workbench Xero spike</title><style>body{font:16px system-ui;max-width:680px;margin:60px auto;padding:0 24px;color:#20242b}a{display:inline-block;background:#31538f;color:white;padding:10px 16px;border-radius:8px;text-decoration:none}code{background:#f3f4f6;padding:2px 5px;border-radius:4px}</style><h1>Workbench Xero capability experiment</h1><p>Connect only the UK demo company. The app requests transaction-write scopes so the experiment can create and reverse marked test objects.</p><p><a href="${authorizationUrl.toString()}">Connect UK demo company</a></p><p>No Xero password or MFA value is handled by this local server.</p>`);
        return;
      }
      if (requestUrl.pathname === '/oauth/callback') {
        if (requestUrl.searchParams.get('state') !== csrfState) throw new Error('OAuth state did not match; restart the connection flow.');
        const oauthError = requestUrl.searchParams.get('error');
        if (oauthError) throw new Error(`Xero authorisation returned ${oauthError}: ${requestUrl.searchParams.get('error_description') || 'no description'}`);
        const code = requestUrl.searchParams.get('code');
        if (!code) throw new Error('Xero callback did not include an authorisation code.');
        const token = await requestToken(config, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.redirectUri
        });
        await saveToken(token);
        const connections = await getConnections(config);
        const names = connections.map(connection => connection.tenantName).join(', ') || 'none';
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(`<!doctype html><meta charset="utf-8"><title>Xero connected</title><style>body{font:16px system-ui;max-width:680px;margin:60px auto;padding:0 24px;color:#20242b}</style><h1>Xero connection stored locally</h1><p>Connected tenant(s): <strong>${escapeHtml(names)}</strong></p><p>You can return to Codex. No token is displayed in this page.</p>`);
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch (error) {
      console.error(error.message);
      response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><title>Xero connection failed</title><h1>Connection failed</h1><pre>${escapeHtml(error.message)}</pre>`);
    }
  });

  server.listen(Number(redirect.port || 80), '127.0.0.1', () => {
    console.log(`Xero OAuth harness listening at http://localhost:${redirect.port || 80}/`);
    console.log('Open that URL in the in-app browser and connect only the UK demo company.');
  });
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

const command = process.argv[2] || 'check';
const commands = {
  check: commandCheck,
  serve: commandServe,
  connections: commandConnections,
  baseline: commandBaseline,
  prepare: commandPrepare,
  observe: commandObserve
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Available commands: ${Object.keys(commands).join(', ')}`);
  process.exitCode = 2;
} else {
  try {
    await commands[command]();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
