# Crédits des ressources réalistes (mission 1)

## Modèles 3D — Muster WWII Model Archive
Soldats, armes (Mosin-Nagant, PPSh-41, Kar98k, MP40, MG42, Thompson, DP-27, Lee-Enfield), camion Opel Blitz,
canon Flak 36 et grenade à manche : modélisés par le projet Muster (https://github.com/Kenton-GMI/muster-ww2),
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
Mosin-Nagant (fusil), PPSh (mitraillette), Colt 1911 (pistolet), Carl Gustav M45 (fusil-mitrailleur de Kroll) :
tirs côté tireur, proche, moyen et lointain, culasse, chargeurs. Découpés avec `tools/prepare-sounds.py`.

## Pas, douilles, voix, impacts, ambiances — Oculus Audio Pack 1 (CC BY 4.0)
© Meta / Oculus, publié dans https://github.com/facebookincubator/Meta-open-sound
(licence : https://creativecommons.org/licenses/by/4.0/). Extraits découpés et réencodés en MP3.
