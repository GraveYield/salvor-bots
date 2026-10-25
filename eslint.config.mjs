// ESLint flat config — Salvor Bots (root SDK mirror + fleet-ops, scout,
// fleet-core, monitor, conservative, sniper, experimental). Phase 1
// (build/reliability): the repo previously had no lint gate at all. This
// config is byte-identical in intent to graveyield-protocol's (check-only,
// prettier owns formatting) and uses the SAME exact-pinned versions, because
// src/ is a byte-equal vendored mirror of graveyield-protocol/sdk/src — the
// two repos must lint/format the mirror identically or the sdk-sync diff
// (enforced in protocol CI) breaks.
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/target/**", "**/node_modules/**", "**/.next/**", "**/*.gen.ts"],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Same tunings as graveyield-protocol (keep in sync): `_`-prefixed
      // intentional-unused convention, rest-sibling omission idiom, and the
      // empty marker-interface allowance for the published SDK surface.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "always" }],
    },
  },
);
