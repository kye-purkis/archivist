const linuxCredentialBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
export function isSecureCredentialBackend(platform: string, backend: string) {
  if (platform === 'linux') return linuxCredentialBackends.has(backend);
  return platform === 'darwin' || platform === 'win32';
}
