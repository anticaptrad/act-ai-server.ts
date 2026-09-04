{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    ores-sops.url = "github:ORESoftware/ores-sops";
  };

  outputs = inputs: (import ./.nix/flake.nix).outputs inputs;
}
