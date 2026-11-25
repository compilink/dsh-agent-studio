/** Return an explicit installed-model tag suitable for the local Ollama adapter. */
export function localModelName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$/.test(name)) {
    throw new Error('Select an installed local model by its Ollama tag');
  }
  return name;
}
