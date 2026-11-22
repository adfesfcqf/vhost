# Crédits des ressources réalistes

## Modèles 3D — Muster WWII Model Archive
Soldats, prisonnier, armes (Mosin-Nagant, PPSh-41, Kar98k, MP40, MG42, M1 Garand, Thompson, BAR, Lee-Enfield, Sten, Bren, DP-27),
camion Opel Blitz, Kübelwagen, char Panzer IV (épave), canon Flak 36 et grenade à manche : modélisés par le projet Muster (https://github.com/Kenton-GMI/muster-ww2),
puis exportés en glTF, allégés, articulés (jambes et bassin) et posés « en joue » pour ce jeu
(voir `tools/export-models.ts` et `tools/muster-aim-pose.patch`).

```
MIT License

Copyright (c) 2026 Kenton Wang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sons d'armes — The Free Firearm Sound Library (CC0 1.0)
Enregistrements de Ben Jaszczak (Kickstarter 2014), miroir : https://github.com/buddingmonkey/FreeFirearmsSFXLibrary.
Mosin-Nagant, Arisaka (pour le Kar98k), Springfield 1917 (pour le Lee-Enfield), SKS (pour le M1 Garand), PPSh,
Carl Gustav M45 (MP40, Thompson, Sten), AK-47 (fusils-mitrailleurs) et Colt 1911 :
tirs côté tireur, proche, moyen et lointain, culasse, chargeurs. Découpés avec `tools/prepare-sounds.py`.

## Pas, douilles, voix, impacts, ambiances — Oculus Audio Pack 1 (CC BY 4.0)
© Meta / Oculus, publié dans https://github.com/facebookincubator/Meta-open-sound
(licence : https://creativecommons.org/licenses/by/4.0/). Extraits découpés et réencodés en MP3.

## Textures photo — ambientCG (CC0 1.0)
Ground037, Ground103, Grass004, Plaster002, Plaster007, Bricks097, Bricks102, Concrete047A, Wood092, Metal055A, Rock063
(https://ambientcg.com), via les dépôts CC0 petroulacl/fps-asset-kit et petroulacl/fps-buildings-env-kit. Réduites en 1024/512 px.

## Ciel — Poly Haven (CC0 1.0)
« Kloppenheim 06 (pure sky) », HDRI de Poly Haven (https://polyhaven.com), converti en image équirectangulaire.

## Créé pour le jeu
Pistolet Colt M1911 (modèle 3D), herbe, silhouettes de pins, tuiles de toit, sacs de sable, impacts de balles,
traces de sang, brûlures, fumée, réverbérations (village, forêt, pierre, intérieur), claquement supersonique,
acouphène après explosion, battements de cœur, guerre lointaine.
