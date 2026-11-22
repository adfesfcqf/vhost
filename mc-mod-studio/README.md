# 🟩 ModCraft Studio — add-ons Minecraft Bedrock

Un éditeur façon VS Code, **fait uniquement pour créer des add-ons Minecraft Bedrock**, ultra simple, avec un **assistant IA** intégré. Application PC Windows.

- ✨ **Créer un add-on en 1 clic** : pack de comportement (BP) + pack de ressources (RP), manifests et UUID générés.
- ➕ **Boutons Item / Bloc / Recette** : gemme, nourriture, épée, pioche, hache, pelle, bloc lumineux… Le JSON, la texture, l'atlas, le son, la loot table et les traductions FR/EN sont créés automatiquement.
- 🎨 **Éditeur de pixels** : clique sur un `.png` pour dessiner tes textures 16×16.
- 🤖 **Assistant IA (Claude)** : « Fais que mon épée mette le feu aux monstres ». L'IA lit tes fichiers, écrit le JSON et les scripts JavaScript (`@minecraft/server`), vérifie et corrige. Bouton **↩ Annuler** pour défaire ses changements.
- ✔ **Vérifier** : trouve les JSON cassés, textures manquantes, traductions oubliées, erreurs de syntaxe dans les scripts. Bouton **« Demander à l'IA de corriger »**.
- ▶ **Tester dans Minecraft** : copie l'add-on dans les dossiers de développement de Minecraft Bedrock et lance le jeu.
- 📥 **Ouvrir un `.mcaddon` / `.mcpack`** : bouton sur l'accueil, glisser-déposer sur la fenêtre, ou clic droit sur le fichier → **Ouvrir dans ModCraft Studio** (le double-clic reste pour Minecraft). Une copie modifiable est créée dans `Documents/ModCraft`.
- 📦 **Exporter** : crée un fichier `.mcaddon` (double-clic = installé dans Minecraft, à partager avec tes amis).

## Ce qu'il faut

1. **Windows 10/11** avec **Minecraft Bedrock** (version 1.21.100 ou plus récente).
2. **Une clé API Claude** pour l'assistant : à créer sur [console.anthropic.com](https://console.anthropic.com/settings/keys), puis à coller dans ⚙ Réglages (stockée chiffrée sur ton PC).

Pas besoin de Java.

## Installer

- **`ModCraft-Studio-x.y.z-portable.exe`** : un seul fichier, double-clic et c'est parti (pas d'installation).
- **`ModCraft-Studio-Setup-x.y.z.exe`** : installateur classique avec raccourci sur le bureau.

Les deux sont construits automatiquement par GitHub Actions (onglet **Actions** → « ModCraft Studio (installateur Windows) » → **Artifacts**).

L'exécutable n'est pas signé : au premier lancement Windows peut afficher « Windows a protégé votre ordinateur ». Clique sur **Informations complémentaires** puis **Exécuter quand même**.

## Tester ton add-on dans Minecraft

1. Clique sur **▶ Tester dans Minecraft**.
2. Dans Minecraft : **Créer un monde** (ou modifier un monde ✏️) → **Packs de comportement** → **Disponibles** → active ton add-on (le pack de ressources suit tout seul).
3. Après chaque modification : reclique sur ▶ Tester, puis quitte et rouvre ton monde.

## Lancer depuis le code

Il faut [Node.js](https://nodejs.org) 20 ou plus.

```bash
cd mc-mod-studio
npm install
npm start
```

Fabriquer les `.exe` (sur Windows) :

```bash
npm run dist
```

## Organisation du code

```
src/
  main.js            Processus principal Electron (fenêtre, fichiers, IA, test, export)
  preload.js         Pont sécurisé vers l'interface
  lib/template.js    Génère l'add-on (BP + RP + manifests)
  lib/generators.js  Items, blocs, recettes "en un clic"
  lib/check.js       Vérification de l'add-on
  lib/minecraft.js   Copie dans Minecraft (development packs) et export .mcaddon
  lib/zip.js         Création des fichiers .mcaddon
  lib/agent.js       Assistant IA : Claude + outils (lire/modifier fichiers, ajouter item/bloc/recette, vérifier)
  lib/files.js       Accès fichiers limité au dossier de l'add-on
  lib/png.js         Textures de départ
  renderer/          Interface (Monaco, éditeur de pixels)
test/smoke.js        Tests (npm test)
```

L'assistant utilise par défaut **Claude Opus 5.5** (Sonnet 5.5 ou Haiku 5.5 au choix dans les réglages, moins chers). Il ne peut lire et écrire que dans le dossier de l'add-on ouvert.
