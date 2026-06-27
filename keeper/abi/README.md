# keeper/abi — vendored ABIs

These are the ABI **arrays** (not full Foundry artifacts) the keeper loads at
runtime via `keeper/lib/abi.mjs`. They ship with the deploy so the keeper never
needs the gitignored `out/` dir — Railway only runs `npm install` + `node`, never
`forge build`.

- `PositionManager.json` — must match the deployed PositionManager (currently
  `0x9396d36f713302ff39e0ba5b38012656f8e4eacf` on chain 4441).
- `MockERC20.json` — ERC20 ABI (incl. `mint`) for the mUSD collateral token.

## Refresh after a contract change + redeploy

```bash
# from repo root, after `forge build`:
node -e 'const fs=require("fs");for(const [s,d] of [
  ["out/PositionManager.sol/PositionManager.json","keeper/abi/PositionManager.json"],
  ["out/MockERC20.sol/MockERC20.json","keeper/abi/MockERC20.json"],
]) fs.writeFileSync(d, JSON.stringify(JSON.parse(fs.readFileSync(s,"utf8")).abi,null,2)+"\n")'
```

Then verify the ABI decodes live reads against the deployed address before
committing the refreshed files.
