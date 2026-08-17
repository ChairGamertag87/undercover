# Undercover en ligne

Jeu d'identités cachées (Undercover / Mr White) jouable à plusieurs, chacun sur son
propre PC. Serveur Node + WebSocket, front sans build ni framework, 500 paires de mots
réparties en 20 thèmes.

## Ce que ça fait

- Salon avec code à 4 caractères et lien partageable (`/r/ABCD`)
- 3 à 16 joueurs, répartition des rôles automatique ou manuelle
- Distribution privée du mot (fiche scellée à maintenir enfoncée)
- Tour d'indices écrits et archivés, ou mode vocal si vous êtes déjà en discord
- Débat chronométré, vote à la majorité, gestion des égalités
- Mr White éliminé a une chance de deviner le mot des civils
- Score cumulé entre les manches (civil 2, undercover 10, Mr White 6)
- Reconnexion automatique : un F5 en pleine partie ne fait pas perdre sa place
- Chat de salle intégré

## Lancer en local

```bash
npm install
npm start
# http://localhost:8080
```

Variables d'environnement : `PORT` (8080), `HOST` (0.0.0.0), `PAIRS_FILE`
(chemin du JSON de paires).

Pour tester à plusieurs sur le réseau local, les autres PC ouvrent
`http://IP_DE_TA_MACHINE:8080`.

## Déploiement Docker

```bash
docker compose up -d --build
```

Le conteneur écoute sur `127.0.0.1:8091`. Voir `nginx.conf.example` pour le vhost :
le point important est le bloc `location /ws` avec les en-têtes `Upgrade` et
`Connection`, sans quoi le WebSocket ne passe pas.

```bash
cp nginx.conf.example /etc/nginx/sites-available/undercover
ln -s /etc/nginx/sites-available/undercover /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## Déploiement sans Docker

```bash
rsync -a --exclude node_modules ./ serveur:/opt/undercover/
ssh serveur 'cd /opt/undercover && npm install --omit=dev'
cp undercover.service.example /etc/systemd/system/undercover.service
systemctl enable --now undercover
```

## Architecture

```
server.js                moteur de jeu + serveur statique + WebSocket (/ws)
data/undercover_paires.json   les 500 paires
public/index.html        squelette des 4 écrans (accueil, salon, partie, verdict)
public/style.css         design system (feutre vert, laiton, papier, tampon rouge)
public/app.js            client : état, rendu ciblé, interactions
```

L'état vit uniquement en mémoire côté serveur, dans une `Map` de salons. Chaque
message serveur envoie deux paquets : `room` (état public, mots et rôles masqués)
et `you` (état privé du joueur). Aucune base de données, un redémarrage vide les
parties en cours.

Endpoints utiles : `GET /healthz` (état + nombre de salons), `GET /api/themes`.

## Machine à états d'une manche

```
lobby -> reveal -> clues -> discussion -> vote -> vote_result -> (clues | ended)
                                            \-> mr_white_guess -> (ended | vote_result)
```

Fin de manche : les civils gagnent quand il ne reste aucun infiltré, les infiltrés
gagnent dès qu'ils sont aussi nombreux que les civils, Mr White gagne seul s'il
devine le mot après son élimination.

## Tests

Trois scripts de simulation qui pilotent de vrais clients WebSocket :

```bash
PORT=8099 node server.js &
node test-sim.js              # partie complète à 6 joueurs
node test-scenarios.js civils # victoire civils
node test-scenarios.js mrwhite# Mr White qui devine juste
node test-reconnect.js        # coupure, reconnexion, manche suivante
```

## Limites connues

- Pas de persistance : salon perdu au redémarrage du process
- Un salon inactif est purgé après 10 minutes sans joueur connecté
- Pas de rejoin en cours de partie pour un nouveau joueur (uniquement reconnexion
  d'un joueur déjà assis)
