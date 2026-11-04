// Text as search compares it: lower case, without accents, so "cafe" finds "Café", "lodz" finds
// "Łódź" and "strasse" finds "Straße", as in Obsidian. The core's note search folds the same way
// (vault.rs, `fold`).

/** Letters that carry no separate accent mark, so Unicode decomposition leaves them as they are. */
const WHOLE: Record<string, string> = {
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  ħ: "h",
  ı: "i",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
  ŧ: "t",
};

export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[øłđðħıßæœþŧ]/g, (c) => WHOLE[c]);
}
