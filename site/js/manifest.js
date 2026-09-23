// The original Dungeon Keeper files KeeperFX needs, and how to find them in whatever the player
// hands us. The list is KeeperFX's own installer's (dkfans/keeperfx-launcher-qt, src/dkfiles.cpp
// at 04f7b3d), which checks names only; so do we. Like the installer we store every name in
// lower case under data/, sound/ and music/, which is where the engine reads them.

export const REQUIRED = [
  "data/bluepal.dat",
  "data/bluepall.dat",
  "data/dogpal.pal",
  "data/hitpall.dat",
  "data/lightng.pal",
  "data/redpal.col",
  "data/redpall.dat",
  "data/slab0-0.dat",
  "data/slab0-1.dat",
  "data/vampal.pal",
  "data/whitepal.col",
  "sound/atmos1.sbk",
  "sound/atmos2.sbk",
  "sound/bullfrog.sbk",
];

// The game's music, as the digital editions ship it. The game plays without it.
export const OPTIONAL = [
  "music/keeper02.ogg",
  "music/keeper03.ogg",
  "music/keeper04.ogg",
  "music/keeper05.ogg",
  "music/keeper06.ogg",
  "music/keeper07.ogg",
];

export const ALL = [...REQUIRED, ...OPTIONAL];

// A data/ or sound/ file must sit in a folder of that name, as the installer checks. The music
// sits in the root of a digital edition or in music/ of a KeeperFX install; its names are
// distinctive enough to take from any folder.
function fits(wanted, candidate) {
  const [dir] = wanted.split("/");
  return dir === "music" || candidate.parent === dir;
}

// paths: the player's relative paths, e.g. "Dungeon Keeper/DATA/BLUEPAL.DAT".
// The first folder of each path is the one they chose, and an Origin copy nests one level
// deeper, so a match may sit at any depth; when several do, the shallowest wins.
// Returns { found: Map(wanted -> their path), missing: [wanted], missingOptional: [wanted] }.
export function matchFiles(paths) {
  const byName = new Map();
  for (const path of paths) {
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    const name = parts.at(-1)?.toLowerCase();
    if (!name) continue;
    const parent = parts.length > 1 ? parts.at(-2).toLowerCase() : "";
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ path, parent, depth: parts.length });
  }

  const found = new Map();
  for (const wanted of ALL) {
    const [, name] = wanted.split("/");
    const candidates = (byName.get(name) ?? [])
      .filter((c) => fits(wanted, c))
      .sort((a, b) => a.depth - b.depth);
    if (candidates.length) found.set(wanted, candidates[0].path);
  }
  return {
    found,
    missing: REQUIRED.filter((w) => !found.has(w)),
    missingOptional: OPTIONAL.filter((w) => !found.has(w)),
  };
}
