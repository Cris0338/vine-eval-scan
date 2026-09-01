# Amazon Vine FR — Références HTML utiles

Référence technique minimale des éléments DOM Amazon utilisés par **Scan Éval**.

Dernière vérification : **31/08/2026**  
But : conserver uniquement les points d'accroche utiles pour les futures modifications du script, sans archiver des pages HTML complètes.

> Les exemples ci-dessous sont volontairement simplifiés et sans ASIN, titres de produits, identifiants de session ou données personnelles.

---

## 1. Page des avis Vine terminés

URL concernée :

```text
/vine/vine-reviews?review-type=completed
```

### Conteneur des boutons Vine

```css
#vvp-review-button-container
```

C'est le conteneur dans lequel Scan Éval ajoute son bouton `Scan` / `Refresh`.

### Ligne d'un avis

```css
tr.vvp-reviews-table--row
```

Chaque avis est traité ligne par ligne.

---

## 2. Colonnes importantes du tableau

### Statut du commentaire

En-tête Amazon vérifié :

```css
#vvp-reviews-table--review-content-heading
```

Le statut `Approuvé`, `Non approuvé`, `En attente d'approbation`, etc. doit être lu **uniquement dans cette colonne**.

Ne jamais utiliser la note de qualité (`Excellent`, `Bien`, `En attente`...) pour déterminer si un commentaire est approuvé ou non.

### Qualité de l'avis

En-tête Amazon vérifié :

```css
#vvp-reviews-table--review-quality-score-heading
```

Valeurs observées :

```text
En attente
Excellent
Bien
Juste
Pauvre
```

Cette colonne est indépendante du statut du commentaire.

---

## 3. Date de commande

Sélecteur vérifié :

```css
td[data-order-timestamp]
```

Exemple simplifié :

```html
<td data-order-timestamp="TIMESTAMP_MS">16/08/2026</td>
```

### Règle importante

`data-order-timestamp` est la **source canonique** pour la date de commande.

Le texte visible `16/08/2026` est pratique pour l'affichage, mais peut être absent d'anciens enregistrements locaux. Le script doit donc pouvoir reconstruire la date affichée à partir de `orderTs`.

Champs internes utilisés :

```text
orderTs       = valeur de data-order-timestamp
orderDateText = texte visible DD/MM/YYYY, si disponible
```

Fallback recommandé pour l'interface :

```text
orderDateText || format(orderTs) || "—"
```

---

## 4. Produit

### Colonne image

```css
td.vvp-reviews-table--image-col img
```

### Lien produit

Amazon utilise notamment :

```css
#vvp-reviews-product-detail-page-link
```

ou un lien contenant :

```text
/dp/ASIN
/gp/product/ASIN
```

L'ASIN peut être extrait de ces liens pour servir de **clé locale**.

> Ne jamais construire une URL de modification d'avis à partir de l'ASIN. L'URL de modification doit toujours provenir du vrai lien Amazon présent dans la ligne.

---

## 5. Avis approuvé

Exemple simplifié :

```html
<td data-review-content="...">Approuvé</td>
<td>Excellent</td>
<a
  name="vvp-reviews-table--see-review-btn"
  href="/gp/customer-reviews/REVIEW_ID"
>Voir le commentaire</a>
```

Points utiles :

```css
[data-review-content]
a[name="vvp-reviews-table--see-review-btn"]
```

---

## 6. Avis `Non approuvé`

Structure observée :

```html
<td data-review-content="...">
  <div class="vvp-red-text">Non approuvé</div>
</td>
```

Sélecteur utile :

```css
.vvp-red-text
```

La détection principale reste toutefois basée sur le **texte de la colonne Statut du commentaire**, pas uniquement sur la couleur ou la classe CSS.

---

## 7. Vrai bouton Amazon `Revoir`

Pour un avis `Non approuvé`, Amazon fournit le vrai lien de modification :

```html
<a
  name="vvp-reviews-table--review-item-btn"
  href="/review/create-review?encoding=UTF&channel=vine-portal&asin=ASIN"
>Revoir</a>
```

Sélecteur prioritaire :

```css
a[name="vvp-reviews-table--review-item-btn"][href*="/review/create-review"]
```

Texte observé :

```text
Revoir
```

### Règle absolue

Toujours conserver et utiliser **le `href` réel fourni par Amazon**.

L'ASIN n'est qu'une clé de stockage/recherche locale.

---

## 8. Page de modification disponible

URL :

```text
/review/create-review...
```

### Formulaire principal Amazon

Sélecteurs vérifiés :

```css
form#in-context-ryp-form
form[data-testid="in-context-ryp-form"]
```

Le formulaire réellement modifiable doit contenir :

```css
#reviewText
#reviewTitle
```

Exemple simplifié :

```html
<form
  id="in-context-ryp-form"
  data-testid="in-context-ryp-form"
>
  <textarea id="reviewText" name="reviewText"></textarea>
  <input id="reviewTitle" name="reviewTitle">
</form>
```

La présence simultanée du formulaire + `#reviewText` + `#reviewTitle` est notre marqueur fiable d'un avis modifiable.

---

## 9. Étoiles

Sur la version observée de l'éditeur, Amazon utilise des contrôles :

```css
[role="radio"][aria-checked="true"]
```

Les libellés peuvent contenir `étoile` / `étoiles`.

Pour suivre une modification réelle, le script doit comparer l'état initial et final des étoiles, pas seulement surveiller un clic.

---

## 10. Médias

Entrée fichier observée :

```css
input[type="file"]
#media
```

Les changements photo/vidéo font partie des modifications qui doivent pouvoir déclencher `✓ Modifié` après envoi réel.

---

## 11. Vrai bouton Amazon `Envoyer`

Structure observée :

```html
<span class="ryp-submit-button-desktop">
  <span class="a-button-inner">
    <input type="submit" class="a-button-input" aria-labelledby="...">
    <span class="a-button-text">Envoyer</span>
  </span>
</span>
```

Sélecteur très utile :

```css
.ryp-submit-button-desktop .a-button-input[type="submit"]
```

### Attention aux autres userscripts

D'autres userscripts peuvent injecter des `<button>` dans le même `<form>` Amazon.

Il ne faut donc **jamais considérer n'importe quel `submit` du formulaire comme un envoi réel**.

`✓ Modifié` doit être enregistré uniquement si :

1. texte, titre, étoiles ou médias ont réellement changé ;
2. le contrôle utilisé est le vrai bouton Amazon `Envoyer`.

Ouvrir simplement la page ne compte pas comme modification.

---

## 12. Page où le commentaire n'est plus modifiable

Marqueurs Amazon vérifiés :

```css
[data-hook="ryp-error-page-text"]
[data-hook="ryp-icon-alert"]
```

Exemple simplifié :

```html
<div data-hook="ryp-error-page-text">
  <div data-hook="ryp-icon-alert" role="alert">
    Désolé, mais Amazon n'accepte pas les commentaires sur ce produit depuis ce compte.
  </div>
</div>
```

Si l'un de ces marqueurs est présent sur la vraie page Amazon, l'avis est considéré comme **non modifiable 🚫**.

---

## 13. Page spéciale `Non approuvés` de Scan Éval

Cette page est générée par notre userscript, pas par Amazon.

Deux groupes seulement :

```text
Modifiables ✏️
Non modifiables 🚫
```

### Non modifiables

États du bouton :

```text
Vérifier
✓ Visité
✓ Vérifié
```

Le clic sur `Vérifier` ouvre le vrai lien Amazon dans un nouvel onglet et marque immédiatement l'entrée comme visitée.

Une case `Modifiable` permet de promouvoir manuellement une entrée mal classée : elle passe alors dans la section `Modifiables`.

### Modifiables

`✓ Modifié` apparaît seulement après une vraie modification suivie du vrai `Envoyer` Amazon.

---

## 14. Période d'évaluation Vine

Sur `/vine/account`, le point d'accroche principal utilisé est :

```css
#vvp-evaluation-period-tooltip-trigger
```

Le script extrait ensuite la date de début de période depuis le texte Amazon.

Formats supportés :

```text
DD/MM/YYYY
jour mois français année
```

---

## 15. Pagination

Sélecteur utile :

```css
ul.a-pagination a[href*="page="]
```

Le Scan et le Refresh ne doivent pas dépendre uniquement du numéro de page actuel : les avis peuvent se décaler entre deux passages.

---

## 16. Principes à conserver lors des futures modifications

1. `Statut du commentaire` et qualité de l'avis sont deux informations indépendantes.
2. `Non approuvé` vient exclusivement du statut Amazon.
3. La date canonique vient de `data-order-timestamp`.
4. Utiliser le vrai `href` Amazon pour `Revoir` ; ne jamais fabriquer l'URL depuis l'ASIN.
5. L'ASIN sert principalement de clé locale.
6. Une page avec le vrai formulaire Amazon est modifiable.
7. Une page avec `ryp-error-page-text` / `ryp-icon-alert` est non modifiable.
8. Une page ouverte n'est pas une page modifiée.
9. `✓ Modifié` nécessite changement réel + vrai `Envoyer`.
10. Les contrôles manuels (`Visité`, `Vérifié`, promotion `Modifiable`) doivent rester persistants lors des Refresh suivants.
11. Ne pas dépendre des classes/couleurs seules si un attribut ou un identifiant Amazon plus stable existe.
12. Si Amazon modifie le DOM, mettre à jour ce document en même temps que le script.

---

## 17. Sources de référence utilisées pour établir cette fiche

Cette fiche a été construite à partir de trois cas réels observés sur Amazon France :

- ligne Vine avec avis `Approuvé` ;
- ligne Vine avec avis `Non approuvé` et bouton `Revoir` ;
- page `/review/create-review` avec formulaire disponible ;
- page `/review/create-review` refusée avec `ryp-error-page-text` / `ryp-icon-alert`.

Les dumps HTML complets ne sont pas nécessaires une fois ces points d'accroche vérifiés et documentés ici.
