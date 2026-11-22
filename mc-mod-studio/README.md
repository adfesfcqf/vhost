# 🟩 ModCraft Studio

Un éditeur façon VS Code, **fait uniquement pour créer des mods Minecraft**, ultra simple, avec un **assistant IA** intégré.
Application PC (Windows, et aussi macOS / Linux).

- ✨ **Créer un mod en 1 clic** : Fabric pour Minecraft 1.21.1, tout est préparé (Gradle, fichiers, onglet créatif).
- ➕ **Boutons Item / Bloc / Recette** : gemme, nourriture, épée, pioche, hache, pelle, bloc lumineux… Le code Java, les modèles, les traductions FR/EN, la loot table et une texture de départ sont générés automatiquement.
- 🎨 **Éditeur de pixels** : clique sur un `.png` pour dessiner tes textures 16×16 (crayon, gomme, pot de peinture, pipette, grain façon Minecraft).
- 🤖 **Assistant IA (Claude)** : « Ajoute une épée en rubis qui met le feu aux ennemis ». L'IA lit tes fichiers, écrit le code, compile pour vérifier et corrige ses erreurs. Bouton **↩ Annuler** pour défaire ce qu'elle a changé.
- 🔨 **Compiler** / ▶ **Tester dans Minecraft** (lance le jeu avec ton mod) / 📦 **Installer** (copie le `.jar` dans `.minecraft/mods`).
- 🧯 Compilation ratée ? Bouton **« Demander à l'IA de corriger »**.
- 📝 Éditeur de code Monaco (le même moteur que VS Code).

## Ce qu'il faut sur ton PC

1. **Java 21** — [Temurin 21](https://adoptium.net/temurin/releases/?version=21) (l'appli te dit si Java est détecté).
2. **Une clé API Claude** pour l'assistant — à créer sur [console.anthropic.com](https://console.anthropic.com/settings/keys), puis à coller dans ⚙ Réglages. Elle est stockée chiffrée sur ton PC.
3. Internet la première fois (Gradle télécharge Minecraft et Fabric, ça peut prendre quelques minutes).

## Installer

### Option 1 : l'installateur Windows (.exe)
Le workflow GitHub Actions **« ModCraft Studio (installateur Windows) »** construit `ModCraft Studio Setup x.y.z.exe` automatiquement.
Va dans l'onglet **Actions** du dépôt → dernière exécution → section **Artifacts** → `ModCraft-Studio-Setup`.

### Option 2 : lancer depuis le code
Il faut [Node.js](https://nodejs.org) 20 ou plus.

```bash
cd mc-mod-studio
npm install
npm start
```

Pour fabriquer toi-même l'installateur sur un PC Windows :

```bash
npm run dist
```

Le fichier apparaît dans `mc-mod-studio/dist/`.

## Comment ça marche (pour les curieux)

```
src/
  main.js            Processus principal Electron (fenêtre, fichiers, Gradle, IA)
  preload.js         Pont sécurisé vers l'interface
  lib/template.js    Génère le projet Fabric (versions récupérées en ligne au moment de la création)
  lib/generators.js  Items, blocs, recettes "en un clic"
  lib/agent.js       Assistant IA : Claude + outils (lire/modifier fichiers, ajouter item/bloc/recette, compiler)
  lib/gradle.js      Lance gradlew (build, runClient), détecte Java
  lib/files.js       Accès fichiers limité au dossier du mod
  lib/png.js         Génère les textures de départ
  renderer/          Interface (HTML/CSS/JS, Monaco, éditeur de pixels)
test/smoke.js        Tests (npm test)
```

- Les mods utilisent les **mappings officiels Mojang** (mêmes noms de classes que NeoForge).
- Les lignes `// @modcraft:items` et `// @modcraft:blocks` dans `ModItems.java` / `ModBlocks.java` servent de repères aux boutons ➕ : ne les supprime pas.
- L'assistant utilise par défaut **Claude Opus 5.5** (modifiable dans les réglages : Sonnet 5.5 moins cher, Haiku 5.5 très peu cher), avec le repli automatique côté serveur activé.
- L'IA ne peut lire/écrire que dans le dossier du mod ouvert et ne peut lancer que la compilation (pas de commandes arbitraires).
