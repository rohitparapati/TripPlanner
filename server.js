const express = require('express');
const http = require('http');
const path = require('path');
require('dotenv').config();

const socketIO = require('socket.io');
const mongoose = require('mongoose');

const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);

// IMPORTANT: allow credentials (cookies) for socket handshake
const io = socketIO(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = process.env.PORT || 4000;
const dbURL = process.env.MONGODB_URI;

// ===============================
// MongoDB
// ===============================
mongoose.connect(dbURL)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => console.error('Could not connect to MongoDB:', err));

// ===============================
// Session Middleware (SHARED)
// ===============================
const sessionMiddleware = session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,           // set true only with HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
});

// Express middleware
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Socket.IO middleware (same session middleware)
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ===============================
// Models
// ===============================
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, required: true, unique: true }
}));

const tripSchema = new mongoose.Schema({
  tripId: { type: String, required: true, unique: true },
  destinationCity: { type: String, required: false },
  destinationCountry: { type: String, required: false },
  itinerary: [
    {
      name: String,
      upvotes: { type: Number, default: 0 },
      downvotes: { type: Number, default: 0 }
    }
  ],
  markers: [
    {
      lat: Number,
      lng: Number,
      description: String
    }
  ],
  mapCenter: { lat: Number, lng: Number },
  zoomLevel: { type: Number, default: 4 }
});

const Trip = mongoose.model('Trip', tripSchema);

// ===============================
// Auth Routes
// ===============================
app.post('/signup', async (req, res) => {
  const { username, password, email } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, email });
    await user.save();

    req.session.username = username;
    req.session.save(() => res.status(201).send('Signup successful'));
  } catch (err) {
    if (err.code === 11000) {
      res.status(400).send('Username or email already exists');
    } else {
      console.error('Error during signup:', err);
      res.status(500).send('Signup failed');
    }
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username });
    if (user && await bcrypt.compare(password, user.password)) {
      req.session.username = username;
      req.session.save(() => res.status(200).send('Login successful'));
    } else {
      res.status(401).send('Invalid credentials');
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Login error');
  }
});

// Session check
app.get('/session', (req, res) => {
  if (req.session.username) {
    return res.json({ loggedIn: true, username: req.session.username });
  }
  res.json({ loggedIn: false });
});

// Logout (optional)
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.sendStatus(200));
});

// ===============================
// Auth Middleware
// ===============================
function isAuthenticated(req, res, next) {
  if (req.session.username) return next();
  res.status(401).send('Please log in');
}

// ===============================
// Join Trip (protected)
// ===============================
app.post('/join-trip', isAuthenticated, async (req, res) => {
  const { tripId, destinationCity, destinationCountry } = req.body;

  if (!tripId) return res.status(400).send('Trip ID is required');

  try {
    let trip = await Trip.findOne({ tripId });

    if (!trip) {
      if (!destinationCity || !destinationCountry) {
        return res.status(400).send('New trips must include a destination city and country');
      }

      trip = new Trip({
        tripId,
        destinationCity,
        destinationCountry,
        itinerary: [],
        markers: [],
        mapCenter: { lat: 37.0902, lng: -95.7129 },
        zoomLevel: 4
      });

      await trip.save();
    }

    res.status(200).send(`Joined trip: ${tripId}`);
  } catch (err) {
    console.error('Error joining trip:', err);
    res.status(500).send('Error joining trip');
  }
});

// ===============================
// Socket.IO
// ===============================
io.on('connection', (socket) => {
  console.log('Socket connected. Session user:', socket.request.session?.username);

  socket.on('checkTrip', async ({ tripId }, callback) => {
    try {
      const trip = await Trip.findOne({ tripId });
      callback(!!trip);
    } catch (err) {
      console.error('checkTrip error:', err);
      callback(false);
    }
  });

  socket.on('joinTrip', async ({ tripId, username: fallbackUsername }) => {
    const username = socket.request.session?.username || fallbackUsername;
    if (!username) {
      console.log('joinTrip blocked: no session user');
      return;
    }

    try {
      const trip = await Trip.findOne({ tripId });
      if (!trip) return;

      socket.join(tripId);
      socket.emit('tripJoined', { tripId });

      socket.emit('updateItinerary', trip.itinerary);
      socket.emit('updateMarkers', trip.markers);
      socket.emit('centerMap', { lat: trip.mapCenter.lat, lng: trip.mapCenter.lng, zoom: trip.zoomLevel });

      console.log(`Joined trip: ${tripId} as ${username}`);
    } catch (err) {
      console.error('joinTrip error:', err);
    }
  });

  socket.on('saveMapCenter', async ({ tripId, lat, lng, zoom }) => {
    try {
      const trip = await Trip.findOne({ tripId });
      if (!trip) return;

      trip.mapCenter = { lat, lng };
      trip.zoomLevel = zoom;
      await trip.save();
    } catch (err) {
      console.error('saveMapCenter error:', err);
    }
  });

  socket.on('addItem', async ({ tripId, item }) => {
    try {
      const trip = await Trip.findOne({ tripId });
      if (!trip) return;

      trip.itinerary.push({ name: item, upvotes: 0, downvotes: 0 });
      await trip.save();

      io.to(tripId).emit('updateItinerary', trip.itinerary);
      console.log(`Added item: ${item} to trip: ${tripId}`);
    } catch (err) {
      console.error('addItem error:', err);
    }
  });

  socket.on('voteItem', async ({ tripId, itemName, vote }) => {
    try {
      const trip = await Trip.findOne({ tripId });
      if (!trip) return;

      const item = trip.itinerary.find(i => i.name === itemName);
      if (!item) return;

      if (vote === 'upvote') item.upvotes += 1;
      if (vote === 'downvote') item.downvotes += 1;

      await trip.save();
      io.to(tripId).emit('updateVotes', item);
    } catch (err) {
      console.error('voteItem error:', err);
    }
  });

  socket.on('addMarker', async ({ tripId, lat, lng, description }) => {
    try {
      const trip = await Trip.findOne({ tripId });
      if (!trip) return;

      trip.markers.push({ lat, lng, description });
      await trip.save();

      io.to(tripId).emit('updateMarkers', trip.markers);
    } catch (err) {
      console.error('addMarker error:', err);
    }
  });

  socket.on('sendMessage', async ({ tripId, username: fallbackUsername, message }) => {
    const username = socket.request.session?.username || fallbackUsername;
    if (!username) {
      console.log('sendMessage blocked: no session user');
      return;
    }

    if (tripId && message) {
      socket.join(tripId);
      io.to(tripId).emit('receiveMessage', { username, message });
      console.log(`Received message from: ${username}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
