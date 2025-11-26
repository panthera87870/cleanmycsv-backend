# 1. Image de base : on utilise un carton d'emballage Node.js propre
FROM node:18-slim 

# 2. On dit que le serveur écoutera le Port 8080 (c'est l'écouteur de requêtes)
ENV PORT 8080 

# 3. On crée un endroit de travail dans le conteneur, comme une table de cuisine
WORKDIR /usr/src/app

# 4. On copie la liste des ingrédients (dépendances) et on les installe
COPY package*.json ./
RUN npm install

# 5. On copie le reste du code (la recette et les instructions)
COPY . .

# 6. La commande de démarrage : on lance le plat (votre serveur)
# Assurez-vous que votre fichier de démarrage s'appelle bien server.js
CMD ["node", "server.js"]