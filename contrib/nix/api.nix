{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  importNpmLock,
  version,
}:

# NOTE (2026-11-19): updated for the compiled Nest entry (installs dist/ and
# runs the thin server.js). The phase 4 migration does not build or verify this
# package; see docs/NIX.md and archive/nestjs-migration/ACCEPTANCE.md. When it is
# resumed, align nodejs_24, install recover.js/admin-socket.js at the package
# root and run the HANDOFF section 3 build/smoke test.
buildNpmPackage rec {
  pname = "opengym-api";
  inherit version;

  src = ./../../api;

  nodejs = nodejs_22;

  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;

  nativeBuildInputs = [ makeWrapper ];

  # buildNpmPackage runs `npm run build` (tsc + the runtime-asset copy). The
  # installed tree is the compiled application; server.js is only the thin
  # loader for dist/src/main.js.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/opengym-api
    cp -r dist node_modules package.json package-lock.json server.js $out/lib/opengym-api/

    mkdir -p $out/bin
    makeWrapper ${nodejs_22}/bin/node $out/bin/opengym-api \
      --add-flags "$out/lib/opengym-api/server.js" \
      --set NODE_ENV production
    runHook postInstall
  '';

  meta = with lib; {
    description = "openGym API — passkey auth + per-user workout data (NestJS on Node.js)";
    homepage = "https://gitlab.com/DuarteSantos8/opengym";
    license = licenses.agpl3Plus;
    platforms = nodejs.meta.platforms;
  };
}
