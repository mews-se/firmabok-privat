# Firmabok privat

Min privata variant av [firmabok](https://github.com/mews-se/firmabok),
anpassad efter min egen bokföring och drift. Den finns bara för mitt
personliga användande — är du intresserad av att köra själv vill du ha
[firmabok](https://github.com/mews-se/firmabok) eller uppströmsprojektet
[accounted](https://github.com/erp-mafia/accounted).

## Installation

```sh
wget -O install-debian.sh https://raw.githubusercontent.com/mews-se/firmabok-privat/main/install-debian.sh
sh install-debian.sh <lan-ip>
```

Uppdatering: samma två kommandon igen. Efter första kontot stänger
`sh install-debian.sh lock` registreringen. Imagen publiceras som
`ghcr.io/mews-se/firmabok-privat`; fördjupning i
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

[AGPL-3.0-or-later](LICENSE).
