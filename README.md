2025-12-19 Scan Refresh Vine
Description du projet et manuel d’installation / d’utilisation
1. Description du projet

Ce script Tampermonkey est un outil d’analyse avancée pour Amazon Vine France, conçu pour :

Scanner toutes les évaluations terminées (review-type=completed)

Classifier automatiquement la qualité des évaluations

Compter les éléments par catégorie :

En attente

Excellent

Bien

Juste

Pauvre

N.P. (non parvenu / non disponible)

Gérer une double vision temporelle :

🔹 Depuis toujours (historique complet)

🔹 Depuis éval (à partir de la période d’évaluation active)

Mémoriser des informations Vine persistantes :

Date de début de la période d’évaluation

Date « Testeur Vine depuis »

Afficher les données directement dans l’interface Vine, sous forme de tableau lisible et compact, sans export externe

Principe fondamental du projet :

Le scan complet doit toujours être fiable, reproductible et indépendant de toute logique incrémentale.

Tout ce qui concerne refresh, delta ou marker est volontairement séparé du scan principal.

2. Architecture conceptuelle

Le projet est organisé en blocs logiques clairement séparés.

A. Scan (cœur du système)

Scan séquentiel de toutes les pages Vine

Rythme humain (2–4 secondes par page + pauses aléatoires)

Aucun marker

Aucune dépendance à un état précédent

Produit un état complet et cohérent

👉 C’est la brique centrale.
Si elle est cassée, le projet perd toute fiabilité.

B. État persistant (LocalStorage)

Stockage local, par domaine (amazon.fr), des données suivantes :

Comptages globaux

Comptages de période

Nombre de pages scannées

Date/heure du dernier scan

États précédents (pour calcul des deltas)

Période d’évaluation

Date Vine depuis

Mode d’affichage (Tout / Période)

Chaque chargement est validé et sécurisé.

C. Capture Compte Vine (/vine/account)

Fonctions dédiées qui :

Lisent les dates depuis le DOM

Écrivent en mémoire une seule fois

Affichent une modale uniquement si une donnée change

N’interfèrent jamais avec le scan ou le refresh

D. Interface utilisateur (UI)

Injection non invasive

Tableau clair à colonnes fixes

En-tête informatif

Menu contextuel (Tout / Période / Reset)

Aucun polling continu

E. Refresh (⚠️ en cours de conception)

Le refresh n’est pas encore intégré car :

il cassait le scan

il mélangeait logique incrémentale et scan complet

il introduisait des effets de bord

👉 Il sera implémenté comme une fonction séparée, jamais comme une modification du scan principal.

3. Manuel d’installation
Prérequis

Navigateur desktop (Chrome, Edge, Firefox)

Extension Tampermonkey

Compte Amazon Vine France

Installation

Ouvrir Tampermonkey

Créer un nouveau script

Coller le code complet du projet

Sauvegarder

Vérifier que le script est activé

Permissions utilisées

GM_xmlhttpRequest → chargement des pages Vine

GM_addStyle → styles UI

localStorage → persistance locale

Aucune communication externe.
Aucun serveur.
Tout reste local.

4. Manuel d’utilisation
4.1 Première configuration (une seule fois)

Aller sur
👉 https://www.amazon.fr/vine/account

Le script :

capture la période d’évaluation

capture Testeur Vine depuis

affiche une modale de confirmation (2 secondes)

Terminé.
Aucune action supplémentaire nécessaire.

4.2 Scan complet

Aller sur
👉 https://www.amazon.fr/vine/vine-reviews?review-type=completed

Cliquer sur Scann Éval

Le script :

démarre à la page 1

scanne toutes les pages disponibles

s’arrête proprement en cas de :

captcha

HTML anormal

erreurs répétées

En fin de scan :

tableau mis à jour

deltas affichés

Dernier Scann mis à jour

💡 Le scan est idempotent :
tu peux le relancer quand tu veux.

4.3 Modes d’affichage

Via le menu ▼ :

Tout → historique complet

Période → uniquement Depuis éval

Le choix est mémorisé.

4.4 Reset

Menu ▼ → Reset

Efface :

comptages

période

mode d’affichage

Vine depuis

⚠️ À utiliser uniquement si :

changement de compte

reset réel de Vine

besoin de repartir de zéro

5. Règles d’or du projet

Ne jamais mélanger scan et refresh

Ne jamais utiliser de marker dans le scan

Ne jamais sauvegarder un marker à mi-parcours

Ne jamais réinitialiser l’état pendant un refresh

UI ≠ logique métier

Capture compte ≠ scan

Si une modification enfreint une de ces règles → bug garanti.

6. État actuel du projet

✔ Scan complet et stable
✔ Persistance fiable
✔ Interface claire
✔ Capture compte correcte
⚠️ Refresh à concevoir proprement (prochaine étape)
