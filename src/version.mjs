// One place for version numbers. A test checks that package.json agrees.
// VERSION is the Stashpad release. STORE_FORMAT is the on-disk layout of a store folder:
//   0 = a store without a marker file (made before format markers existed)
//   1 = a store with .stashpad-store.json
export const VERSION = "0.2.1";
export const STORE_FORMAT = 1;
