# PyInstaller entry shim. dbt-colibri exposes its CLI as the console-script
# `colibri = dbt_colibri.cli.cli:cli`; we freeze that same callable into the
# bk1-colibri binary. bk1 invokes it as `bk1-colibri generate --manifest ... `.
from dbt_colibri.cli.cli import cli

if __name__ == "__main__":
    cli()
