# Amazon Vine FR — Scan Éval — Light

Script Tampermonkey pour Amazon Vine France. Il analyse les avis terminés de la période d’évaluation en cours, affiche les compteurs directement dans Vine, calcule un score pondéré et permet de suivre les avis `Non approuvé`.

Version actuelle : **3.4.9**  
Dernière mise à jour : **01/09/2026**

---

## 🎥 Vidéos — Installation & utilisation

> Ces vidéos montrent **la première version du script**. Elles restent utiles pour comprendre le principe général, mais l’interface et certaines fonctions ont évolué depuis.

### 1️⃣ Installation initiale
[![Installation Amazon Vine FR — Scan Éval](https://img.youtube.com/vi/jv_eiwLMNsQ/hqdefault.jpg)](https://www.youtube.com/watch?v=jv_eiwLMNsQ)

### 2️⃣ Premier scan complet & refresh incrémental
[![Premier scan et refresh Amazon Vine FR — Scan Éval](https://img.youtube.com/vi/IohRjMdgRas/hqdefault.jpg)](https://www.youtube.com/watch?v=IohRjMdgRas)

(Merci a @Ellui pour les avoir réalisées)

---

## 1. Ce que fait le script

Le script fonctionne sur les pages Amazon Vine France :

- `/vine/account` pour mémoriser le début de la période d’évaluation ;
- `/vine/vine-reviews?review-type=completed` pour le Scan et le Refresh ;
- `/review/create-review...` pour suivre les modifications réellement envoyées sur les avis `Non approuvé` modifiables.

Le tableau principal affiche :

- **En attente d'approbation** ;
- **En attente** ;
- **Excellent** ;
- **Bien** ;
- **Juste** ;
- **Pauvre** ;
- **Non approuvé** ;
- les informations du dernier Scan/Refresh ;
- un **score pondéré /4** calculé à partir des avis notés.

Les catégories de qualité et le statut du commentaire sont lus séparément. Un avis est considéré `Non approuvé` uniquement à partir du champ Amazon **Statut du commentaire**.

---

## 2. Période d’évaluation

Avant le premier Scan, ouvrir :

`https://www.amazon.fr/vine/account`

Le script lit la date de début de la période Vine et la mémorise localement.

Le Scan et le Refresh ignorent ensuite les avis antérieurs à cette date.

---

## 3. Scan complet

Sur la page des avis terminés :

`https://www.amazon.fr/vine/vine-reviews?review-type=completed`

Cliquer sur **Scan**.

Le Scan :

- repart de la page 1 ;
- parcourt les pages de la période ;
- classe les avis selon leur qualité ;
- compte séparément les avis `En attente d'approbation` ;
- détecte les avis `Non approuvé` pendant le passage ;
- mémorise les données nécessaires aux Refresh suivants ;
- affiche le total, le nombre de pages et le dernier Scan ;
- recalcule le score pondéré.

Le passage d’une page à l’autre est volontairement temporisé.

---

## 4. Refresh

Après un Scan complet, le bouton devient **Refresh**.

Le Refresh ne repart pas de zéro. Il utilise les informations mémorisées pour retrouver les éléments qui doivent encore être surveillés, notamment :

- les avis `En attente` ;
- les avis `En attente d'approbation` ;
- les avis `Non approuvé` déjà connus.

Il supporte le déplacement des avis d’une page à l’autre lorsque de nouveaux avis apparaissent.

Pendant le Refresh, l’interface affiche la page en cours, par exemple :

`Refresh page 8 ...`

Les trois points sont animés.

Lorsqu’un `Non approuvé` est rencontré, l’affichage devient par exemple :

`Refresh page 8 | Non approuvé: contrôle ...`

Le Refresh met à jour les compteurs sans effacer les données du Scan précédent.

---

## 5. Gestion des avis « Non approuvé »

La colonne principale affiche le nombre d’avis détectés sous la forme :

`2 ✏️ (23 🚫)`

- **✏️** = avis identifié comme modifiable ;
- **🚫** = avis non modifiable ou non confirmé automatiquement comme modifiable.

Le nombre avec le crayon est cliquable et ouvre la page dédiée aux `Non approuvé`.

### Page dédiée

La page contient deux sections :

1. **Modifiables** ;
2. **Non modifiables**.

Pour chaque avis, le script conserve le vrai lien Amazon `Revoir` trouvé dans la ligne Vine. Il ne reconstruit pas artificiellement l’URL à partir de l’ASIN.

### Vérifier un avis

Dans la section des non modifiables :

- **Vérifier** ouvre le vrai lien Amazon dans un nouvel onglet ;
- dès le clic, le bouton devient **✓ Visité** ;
- si Amazon affiche réellement la page de blocage, l’état peut devenir **✓ Vérifié** ;
- si l’avis est finalement modifiable, la case **Modifiable** permet de le reclasser manuellement dans la section des modifiables.

Une promotion manuelle en `Modifiable` est mémorisée et n’est pas annulée par un Refresh suivant.

### Avis modifié

Pour un avis modifiable, le simple fait d’ouvrir l’éditeur ne suffit pas.

Le script compare l’état initial et l’état envoyé :

- texte ;
- titre ;
- étoiles ;
- photos / vidéos.

La mention **✓ Modifié** apparaît uniquement si quelque chose a réellement changé et que le vrai bouton Amazon **Envoyer** a été utilisé.

---

## 6. Données enregistrées

Les données sont stockées uniquement dans le `localStorage` du navigateur pour `amazon.fr` :

- période d’évaluation ;
- compteurs ;
- dernier Scan ;
- état précédent pour les évolutions ;
- informations nécessaires au Refresh ;
- état des `Non approuvé` ;
- liens visités ;
- confirmations manuelles ;
- avis réellement modifiés.

Aucun serveur externe n’est utilisé par le script.

`GM_xmlhttpRequest` sert à charger les pages Amazon nécessaires aux contrôles et `GM_addStyle` à l’interface.

---

## 7. Installation

Prérequis :

- navigateur desktop compatible avec Tampermonkey ;
- extension **Tampermonkey** ;
- compte Amazon Vine France.

Installation manuelle :

1. ouvrir le fichier `amazon-vine-eval-scan.user.js` dans ce dépôt ;
2. afficher la version **Raw** ;
3. copier tout le contenu ;
4. créer un nouveau script dans Tampermonkey ;
5. remplacer le contenu par celui du fichier ;
6. sauvegarder et vérifier que le script est activé.

---

## 8. Reset

Le lien **Reset** efface les données locales utilisées par le script :

- compteurs et état du Scan ;
- période mémorisée ;
- base utilisée pour le Refresh et les `Non approuvé`.

Le bouton redevient ensuite **Scan**.

À utiliser uniquement si l’on veut réellement repartir de zéro.

---

## 9. Résumé du fonctionnement

1. ouvrir `/vine/account` pour mémoriser la période ;
2. ouvrir les avis terminés ;
3. lancer **Scan** une première fois ;
4. utiliser ensuite **Refresh** pour les mises à jour ;
5. cliquer sur le compteur `Non approuvé` pour contrôler les avis concernés ;
6. utiliser `Vérifier`, `Modifiable` et `✓ Modifié` pour suivre leur traitement.

Le script est conçu spécifiquement pour **Amazon Vine France**.