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

## Uppdatering

När en ny version är ute: samma två kommandon igen.

```sh
wget -O install-debian.sh https://raw.githubusercontent.com/mews-se/firmabok-privat/main/install-debian.sh
sh install-debian.sh <lan-ip>
```

Finns utcheckningen kvar går det lika bra därifrån, men då måste den
nya versionen hämtas hem först. Varje version är en enda omskriven
commit, så utcheckningen återställs till den i stället för att dras fram:

```sh
cd ~/firmabok && git fetch origin && git reset --hard origin/main && ./install-debian.sh <lan-ip>
```

Båda vägarna kör bara de nya migrationerna och startar om på den nya
imagen. `.env` och volymerna lämnas orörda.

Efter första kontot stänger `sh install-debian.sh lock` registreringen.
Imagen publiceras som `ghcr.io/mews-se/firmabok-privat`; fördjupning i
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Claude via MCP

Skapa en API-nyckel under Inställningar → API och koppla Claude Desktop
med stdio-bryggan `npx gnubok-mcp`. Bryggan går som standard mot
uppströms molntjänst, så `GNUBOK_URL` måste peka på den egna servern,
annars svarar varje nyckel med 401:

```json
"firmabok": {
  "command": "npx",
  "args": ["gnubok-mcp"],
  "env": {
    "GNUBOK_URL": "http://<lan-ip>/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted",
    "GNUBOK_API_KEY": "gnubok_sk_...",
    "GNUBOK_CLIENT": "claude-desktop"
  }
}
```

Starta om Claude Desktop helt efteråt; bryggan läser inställningarna
bara vid start.

Vad MCP-verktygen inte klarar, och hur samma sak görs i webben, står i
[docs/mcp-kanda-begransningar.md](docs/mcp-kanda-begransningar.md).

[AGPL-3.0-or-later](LICENSE).
