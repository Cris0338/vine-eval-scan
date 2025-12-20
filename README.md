Amazon Vine FR — Scan Éval — Light
Description du projet et manuel d’installation / d’utilisation

Dernière mise à jour : 20/12/2025

1. Description du projet

Ce script Tampermonkey est un outil d’analyse avancée pour Amazon Vine France, conçu pour offrir une vision fiable, lisible et persistante des évaluations terminées (review-type=completed).

Il permet de :

Scanner automatiquement toutes les évaluations terminées

Classifier la qualité des évaluations en catégories normalisées

Compter les éléments par catégorie :

En attente

Excellent

Bien

Juste

Pauvre

N.P. (non parvenu / non disponible)

Calculer un score pondéré (/4) basé sur les avis notés

Suivre les évolutions entre deux exécutions (deltas)

Mettre à jour uniquement les éléments “En attente” via un refresh incrémental sécurisé

Afficher les résultats directement dans l’interface Vine, sans export externe

Vision temporelle

Le script fonctionne exclusivement sur la période d’évaluation active :

🔹 Depuis éval : à partir de la date officielle de début de période Vine

Les éléments hors période sont automatiquement ignorés

2. Principe fondamental du projet

Le scan complet doit toujours être fiable, reproductible et indépendant.

Principes clés :

Le scan est idempotent et autonome

Le refresh est incrémental et strictement séparé

Aucune logique incrémentale n’interfère avec le scan

Aucun “marker” n’est utilisé dans le scan

Toute donnée persistée est validée et nettoyée

Si ces règles sont enfreintes → bug garanti.

3. Architecture conceptuelle

Le projet est structuré en blocs indépendants.

A. Scan (cœur du système)

Scan séquentiel de toutes les pages Vine

Rythme humain :

2 à 4 secondes par page

pauses aléatoires

Aucune dépendance à un état précédent

Aucune écriture partielle ou intermédiaire

Arrêt automatique :

fin de période détectée

captcha / login

HTML invalide ou erreurs répétées

👉 Le scan produit un état complet, cohérent et fiable.

B. État persistant (LocalStorage)

Stockage local par domaine (amazon.fr) :

Comptages par catégorie

Nombre total d’éléments scannés

Nombre de pages scannées

Date / heure du dernier scan

État précédent (pour calcul des deltas)

Période d’évaluation active

Base ASIN dédiée au refresh (pending)

Nettoyage automatique des entrées invalides ou “unknown”.

Aucune communication externe.
Aucun serveur.
Tout reste local.

C. Capture Compte Vine (/vine/account)

Fonctions dédiées qui :

Lisent la date de début de période directement depuis le DOM

Supportent formats :

DD/MM/YYYY

mois français

Écrivent en mémoire uniquement si la valeur change

Affichent une modale d’information (2 secondes) uniquement en cas de modification

⚠️ Cette capture :

n’interfère jamais avec le scan

n’interfère jamais avec le refresh

D. Interface utilisateur (UI)

Injection non invasive dans la page Vine

Layout flex :

tableau à gauche

carte score à droite

Tableau clair à colonnes fixes

En-tête informatif :

Dernier scan

Infos d’exécution

Carte “Score pondéré /4” :

nombre d’avis notés

label qualitatif (Excellent / Moyen / Mauvais)

Animation visuelle légère (pulse x3) sur mise à jour

Synchronisation de hauteur :

carte = master

tableau = slave (desktop)

flow normal en mobile

Aucun polling continu.
Aucune surcharge DOM.

E. Refresh (incrémental, sécurisé)

Le refresh est désormais pleinement implémenté, en respectant strictement les règles d’or.

Fonctionnement :

S’appuie uniquement sur les éléments En attente

Ne relance jamais un scan complet

Accepte le déplacement (“shift”) des entrées entre pages

Met à jour :

les changements de statut

les changements de note

Ajuste correctement les compteurs :

décrément ancien état

incrément nouvel état

Arrêt automatique :

hors période

captcha / login

HTML invalide

Le refresh est idempotent, sûr, et non destructif.

4. Manuel d’installation
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

5. Manuel d’utilisation
5.1 Première configuration (une seule fois)

Aller sur
👉 https://www.amazon.fr/vine/account

Le script :

capture la période d’évaluation

affiche une modale de confirmation

Terminé.

5.2 Scan complet

Aller sur
👉 https://www.amazon.fr/vine/vine-reviews?review-type=completed

Cliquer sur Scan

Le script :

démarre à la page 1

scanne toutes les pages de la période

s’arrête proprement si nécessaire

En fin de scan :

tableau mis à jour

deltas affichés

score recalculé

💡 Le scan peut être relancé à tout moment.

5.3 Refresh

Après un scan complet :

Le bouton devient Refresh

Le refresh :

met à jour uniquement les “En attente”

ajuste les compteurs si nécessaire

n’altère jamais le scan de référence

5.4 Reset

Lien Reset dans l’interface.

Efface :

comptages

période

états précédents

base refresh

⚠️ À utiliser uniquement si :

changement de compte

reset réel de Vine

besoin de repartir de zéro

6. Règles d’or du projet

Ne jamais mélanger scan et refresh

Ne jamais utiliser de marker dans le scan

Ne jamais sauvegarder un état partiel

Ne jamais réinitialiser pendant un refresh

UI ≠ logique métier

Capture compte ≠ scan

7. État actuel du projet

✔ Scan complet stable
✔ Persistance fiable
✔ Interface claire et lisible
✔ Capture Compte Vine robuste
✔ Refresh incrémental sécurisé
✔ Bug des “articles non disponibles” corrigé
