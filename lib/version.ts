/**
 * App version + about-page constants.
 *
 * The version is baked at build time into the public env var
 * NEXT_PUBLIC_APP_VERSION (see next.config.ts). In CI the release
 * workflow rewrites `package.json#version` from the pushed git tag; in a
 * working checkout it stays "0.0.0", so scripts/app-version.cjs falls
 * back to `git describe` and both the chip and the packaged app report
 * the nearest release tag instead of v0.0.0.
 */

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

export const GITHUB_OWNER = "beltromatti";
export const GITHUB_REPO = "get-it";
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;

export const FEEDBACK_EMAIL = "beltromatti@gmail.com";

export const DISCORD_URL = "https://discord.gg/DpQPswRhsK";

export const TEAM = [
  {
    name: "Mattia Beltrami",
    affiliation: "Politecnico di Milano",
    linkedin: "https://www.linkedin.com/in/mattia-beltrami/",
  },
  {
    name: "Matteo Impieri",
    affiliation: "Politecnico di Milano",
    linkedin: "https://www.linkedin.com/in/matteo-impieri-5b5874331/",
  },
  {
    name: "Filippo Difronzo",
    affiliation: "Politecnico di Milano",
    linkedin: "https://www.linkedin.com/in/filippo-difronzo-3a56701b1/",
  },
  {
    name: "Luca Feggi",
    affiliation: "Università di Padova",
    linkedin: "https://www.linkedin.com/in/luca-feggi-a643133b5/",
  },
] as const;
