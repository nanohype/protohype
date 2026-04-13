describe('Switchboard: service validation', () => {
  const VALID_SERVICES = new Set(['hubspot','google-drive','google-calendar','google-analytics','google-custom-search','stripe']);
  function isValidService(s: string): boolean { return VALID_SERVICES.has(s); }
  test('accepts all configured services', () => { for (const svc of VALID_SERVICES) expect(isValidService(svc)).toBe(true); });
  test('rejects unknown services', () => {
    expect(isValidService('')).toBe(false);
    expect(isValidService('slack')).toBe(false);
    expect(isValidService('../etc/passwd')).toBe(false);
  });
});

describe('Switchboard: MCP response format', () => {
  function mcpSuccess(id: string | number | undefined, data: unknown) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
  }
  function mcpError(id: string | number | undefined, code: number, message: string) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
  test('success response has correct MCP structure', () => {
    const resp = mcpSuccess('req-1', { result: 'ok' });
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe('req-1');
    expect(resp.result.content[0].type).toBe('text');
    expect(JSON.parse(resp.result.content[0].text)).toEqual({ result: 'ok' });
  });
  test('error response has correct MCP structure', () => {
    const resp = mcpError('req-1', -32603, 'Internal error');
    expect(resp.error.code).toBe(-32603);
    expect(resp.error.message).toBe('Internal error');
  });
  test('handles undefined id', () => { expect(mcpSuccess(undefined, {}).id).toBeUndefined(); });
});

describe('Switchboard: credential env var naming', () => {
  function envKey(service: string): string { return `SECRET_ARN_${service.toUpperCase().replace(/-/g, '_')}`; }
  test('generates correct env var names', () => {
    expect(envKey('hubspot')).toBe('SECRET_ARN_HUBSPOT');
    expect(envKey('google-drive')).toBe('SECRET_ARN_GOOGLE_DRIVE');
    expect(envKey('google-custom-search')).toBe('SECRET_ARN_GOOGLE_CUSTOM_SEARCH');
    expect(envKey('stripe')).toBe('SECRET_ARN_STRIPE');
  });
});
